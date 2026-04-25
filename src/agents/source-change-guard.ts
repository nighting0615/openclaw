import path from "node:path";
import { normalizeToolName } from "./tool-policy.js";

const DEFAULT_PROTECTED_PREFIXES = [
  "/Users/ai/openclaw/src/openclaw/src",
  "/Users/ai/openclaw/src/openclaw/extensions",
];

const STRUCTURED_FILE_MUTATION_TOOLS = new Set(["edit", "write", "apply_patch"]);
const EXEC_TOOLS = new Set(["exec"]);

const BLOCK_MESSAGE_HEAD =
  "Source-layer change blocked. The OpenClaw embedded agent (telebot, etc.) is not allowed to write inside the protected source tree. Source code edits must be made via Claude Code or Codex CLI on the host.";

export type SourceChangeGuardDecision = { blocked: true; reason: string } | { blocked: false };

function readProtectedPrefixes(): string[] {
  const raw = process.env.OPENCLAW_GUARD_PROTECTED_DIRS;
  if (!raw || !raw.trim()) {
    return DEFAULT_PROTECTED_PREFIXES;
  }
  const parts = raw
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/\/+$/, ""));
  return parts.length > 0 ? parts : DEFAULT_PROTECTED_PREFIXES;
}

function isProtectedPath(absolute: string, prefixes: string[]): boolean {
  const resolved = path.resolve(absolute);
  return prefixes.some((prefix) => resolved === prefix || resolved.startsWith(`${prefix}/`));
}

function readPathParam(params: unknown): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const record = params as Record<string, unknown>;
  const candidate = record.path;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function readApplyPatchPaths(params: unknown): string[] {
  if (!params || typeof params !== "object") {
    return [];
  }
  const record = params as Record<string, unknown>;
  const input = typeof record.input === "string" ? record.input : "";
  if (!input.trim()) {
    return [];
  }
  const paths: string[] = [];
  const lines = input.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/);
    if (match) {
      paths.push(match[2]);
    }
  }
  return paths;
}

function readExecCommandAndWorkdir(params: unknown): { command: string; workdir?: string } {
  if (!params || typeof params !== "object") {
    return { command: "" };
  }
  const record = params as Record<string, unknown>;
  const command = typeof record.command === "string" ? record.command : "";
  const workdir = typeof record.workdir === "string" ? record.workdir : undefined;
  return { command, workdir };
}

type ShellWord = {
  kind: "word";
  value: string;
  quoted: boolean;
  precededByRedirect?: ">" | ">>" | ">|";
};
type ShellBoundary = { kind: "boundary" };
type ShellToken = ShellWord | ShellBoundary;

function tokenizeShellCommand(input: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let buffer = "";
  let bufferQuoted = false;
  let inSingle = false;
  let inDouble = false;
  let pendingRedirect: ">" | ">>" | ">|" | undefined;

  const flushToken = () => {
    if (buffer.length === 0 && !bufferQuoted) {
      return;
    }
    tokens.push({
      kind: "word",
      value: buffer,
      quoted: bufferQuoted,
      ...(pendingRedirect ? { precededByRedirect: pendingRedirect } : {}),
    });
    pendingRedirect = undefined;
    buffer = "";
    bufferQuoted = false;
  };

  const emitBoundary = () => {
    flushToken();
    pendingRedirect = undefined;
    if (tokens.length === 0 || tokens[tokens.length - 1].kind === "boundary") {
      return;
    }
    tokens.push({ kind: "boundary" });
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
        bufferQuoted = true;
      } else {
        buffer += ch;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
        bufferQuoted = true;
      } else if (ch === "\\" && i + 1 < input.length) {
        const next = input[i + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`" || next === "\n") {
          buffer += next;
          i += 1;
        } else {
          buffer += ch;
        }
      } else {
        buffer += ch;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      buffer += input[i + 1];
      i += 1;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\n") {
      flushToken();
      continue;
    }

    if (ch === ";" || ch === "&" || ch === "|") {
      emitBoundary();
      if (ch === "&" && input[i + 1] === "&") {
        i += 1;
      } else if (ch === "|" && input[i + 1] === "|") {
        i += 1;
      } else if (ch === "|" && input[i + 1] === "&") {
        i += 1;
      }
      continue;
    }

    if (ch === ">") {
      flushToken();
      if (input[i + 1] === ">") {
        pendingRedirect = ">>";
        i += 1;
      } else if (input[i + 1] === "|") {
        pendingRedirect = ">|";
        i += 1;
      } else {
        pendingRedirect = ">";
      }
      continue;
    }

    buffer += ch;
  }
  flushToken();
  return tokens;
}

function splitStatements(tokens: ShellToken[]): ShellWord[][] {
  const statements: ShellWord[][] = [];
  let current: ShellWord[] = [];
  for (const token of tokens) {
    if (token.kind === "boundary") {
      if (current.length > 0) {
        statements.push(current);
        current = [];
      }
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) {
    statements.push(current);
  }
  return statements;
}

const KNOWN_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

function findExecWriteTargets(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) {
    return [];
  }
  const tokens = tokenizeShellCommand(trimmed);
  const statements = splitStatements(tokens);
  const targets: string[] = [];

  for (const statementTokens of statements) {
    if (statementTokens.length === 0) {
      continue;
    }

    for (const token of statementTokens) {
      if (token.precededByRedirect) {
        targets.push(token.value);
      }
    }

    const head = path.basename(statementTokens[0].value || "").toLowerCase();
    const positional = statementTokens.filter((token) => !token.precededByRedirect).slice(1);
    const nonFlag = positional.filter((token) => !token.value.startsWith("-"));

    if (KNOWN_SHELLS.has(head)) {
      const dashCIndex = positional.findIndex((token) => token.value === "-c");
      if (dashCIndex !== -1 && positional[dashCIndex + 1]) {
        targets.push(...findExecWriteTargets(positional[dashCIndex + 1].value));
      }
      continue;
    }

    switch (head) {
      case "tee": {
        for (const token of nonFlag) {
          targets.push(token.value);
        }
        break;
      }
      case "cp":
      case "mv":
      case "install":
      case "ln": {
        if (nonFlag.length >= 2) {
          targets.push(nonFlag[nonFlag.length - 1].value);
        }
        break;
      }
      case "rm":
      case "unlink":
      case "rmdir":
      case "mkdir":
      case "touch": {
        for (const token of nonFlag) {
          targets.push(token.value);
        }
        break;
      }
      case "chmod":
      case "chown":
      case "chgrp": {
        for (let i = 1; i < nonFlag.length; i += 1) {
          targets.push(nonFlag[i].value);
        }
        break;
      }
      case "sed":
      case "gsed": {
        const hasInPlace = positional.some((token) => /^-i(\..+)?$/.test(token.value));
        if (hasInPlace && nonFlag.length >= 2) {
          for (let i = 1; i < nonFlag.length; i += 1) {
            targets.push(nonFlag[i].value);
          }
        }
        break;
      }
      case "perl": {
        const hasInPlace = positional.some((token) => /^-i(\..+)?$/.test(token.value));
        if (hasInPlace) {
          for (const token of nonFlag) {
            targets.push(token.value);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return targets;
}

function classifyExecCommand(args: {
  command: string;
  workdir?: string;
  prefixes: string[];
}): { hit: true; target: string } | { hit: false } {
  const targets = findExecWriteTargets(args.command);
  for (const candidate of targets) {
    if (!candidate) {
      continue;
    }
    const absolute = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(args.workdir ?? process.cwd(), candidate);
    if (isProtectedPath(absolute, args.prefixes)) {
      return { hit: true, target: path.resolve(absolute) };
    }
  }
  return { hit: false };
}

function extractStructuredCandidatePaths(toolName: string, params: unknown): string[] {
  if (toolName === "edit" || toolName === "write") {
    const candidate = readPathParam(params);
    return candidate ? [candidate] : [];
  }
  if (toolName === "apply_patch") {
    return readApplyPatchPaths(params);
  }
  return [];
}

export function evaluateSourceChangeGuard(args: {
  toolName: string;
  params: unknown;
  cwd?: string;
  protectedPrefixes?: string[];
}): SourceChangeGuardDecision {
  const normalized = normalizeToolName(args.toolName || "");
  const prefixes = args.protectedPrefixes ?? readProtectedPrefixes();

  if (STRUCTURED_FILE_MUTATION_TOOLS.has(normalized)) {
    const candidates = extractStructuredCandidatePaths(normalized, args.params);
    const cwd = args.cwd ?? process.cwd();
    for (const candidate of candidates) {
      const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
      if (isProtectedPath(absolute, prefixes)) {
        return {
          blocked: true,
          reason: `${BLOCK_MESSAGE_HEAD} Tool: ${normalized}. Path: ${path.resolve(absolute)}`,
        };
      }
    }
    return { blocked: false };
  }

  if (EXEC_TOOLS.has(normalized)) {
    const { command, workdir } = readExecCommandAndWorkdir(args.params);
    if (!command) {
      return { blocked: false };
    }
    const result = classifyExecCommand({
      command,
      workdir: workdir ?? args.cwd,
      prefixes,
    });
    if (result.hit) {
      return {
        blocked: true,
        reason: `${BLOCK_MESSAGE_HEAD} Tool: ${normalized}. Detected write to: ${result.target}`,
      };
    }
    return { blocked: false };
  }

  return { blocked: false };
}

export const __testing = {
  DEFAULT_PROTECTED_PREFIXES,
  STRUCTURED_FILE_MUTATION_TOOLS,
  EXEC_TOOLS,
  readProtectedPrefixes,
  readApplyPatchPaths,
  tokenizeShellCommand,
  findExecWriteTargets,
};
