import path from "node:path";
import { normalizeToolName } from "./tool-policy.js";

const DEFAULT_PROTECTED_PREFIXES = [
  "/Users/ai/openclaw/src/openclaw/src",
  "/Users/ai/openclaw/src/openclaw/extensions",
];

const FILE_MUTATION_TOOLS = new Set(["edit", "write", "apply_patch"]);

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

function extractCandidatePaths(toolName: string, params: unknown): string[] {
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
  if (!FILE_MUTATION_TOOLS.has(normalized)) {
    return { blocked: false };
  }
  const candidates = extractCandidatePaths(normalized, args.params);
  if (candidates.length === 0) {
    return { blocked: false };
  }
  const prefixes = args.protectedPrefixes ?? readProtectedPrefixes();
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

export const __testing = {
  DEFAULT_PROTECTED_PREFIXES,
  FILE_MUTATION_TOOLS,
  readProtectedPrefixes,
  readApplyPatchPaths,
};
