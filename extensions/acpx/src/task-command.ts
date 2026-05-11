import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { OpenClawConfig, PluginCommandContext, PluginCommandResult } from "../runtime-api.js";

const execFileAsync = promisify(execFile);

const VALID_CATEGORIES = new Set(["work", "personal", "family", "memo"]);
const DEFAULT_WORKSPACE = "/Users/ai/openclaw/workspaces/main";

type TaskAction = "add" | "done" | "cancel" | "edit" | "list";

type ParsedTaskCommand = {
  action: TaskAction;
  title?: string;
  match?: string;
  due?: string;
  cat?: string;
};

type Token = {
  value: string;
  quoted: boolean;
};

function tokenizeArgs(input: string): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      quoted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current || quoted) {
        tokens.push({ value: current, quoted });
        current = "";
        quoted = false;
      }
      continue;
    }
    current += ch;
  }
  if (quote) {
    throw new Error("Unclosed quote.");
  }
  if (current || quoted) {
    tokens.push({ value: current, quoted });
  }
  return tokens;
}

function readOptionValue(tokens: Token[], index: number, option: string): string {
  const value = tokens[index + 1]?.value;
  if (!value || isOptionToken(value)) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function normalizeOptionToken(value: string): string {
  return value
    .replace(/^[\u2013\u2014\u2015\u2212\uFF0D]{1,2}/u, "--")
    .replace(/^-{1}(?=[A-Za-z])/u, "--");
}

function isOptionToken(value: string): boolean {
  return normalizeOptionToken(value).startsWith("--");
}

function normalizeCat(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().replace(/^#/, "").toLowerCase();
  if (!VALID_CATEGORIES.has(normalized)) {
    throw new Error("--cat must be one of: work, personal, family, memo.");
  }
  return normalized;
}

function parseTaskCommand(input: string | undefined): ParsedTaskCommand {
  const tokens = tokenizeArgs((input ?? "").trim());
  const action = tokens.shift()?.value as TaskAction | undefined;
  if (!action || !["add", "done", "cancel", "edit", "list"].includes(action)) {
    throw new Error("Usage: /task add|done|cancel|edit|list ...");
  }

  const positional: string[] = [];
  let due: string | undefined;
  let cat: string | undefined;
  let title: string | undefined;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = normalizeOptionToken(tokens[i].value);
    if (token === "--due") {
      due = readOptionValue(tokens, i, "--due");
      i += 1;
      continue;
    }
    if (token === "--cat") {
      cat = normalizeCat(readOptionValue(tokens, i, "--cat"));
      i += 1;
      continue;
    }
    if (token === "--title") {
      title = readOptionValue(tokens, i, "--title");
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }
    positional.push(tokens[i].value);
  }

  if (action === "list") {
    return { action, cat };
  }

  if (action === "add") {
    const addTitle = title ?? positional.join(" ").trim();
    if (!addTitle) {
      throw new Error("/task add requires task content.");
    }
    return { action, title: addTitle, due, cat };
  }

  if (action === "edit") {
    const match = positional.join(" ").trim();
    if (!match) {
      throw new Error("/task edit requires match text.");
    }
    if (!title && !due && !cat) {
      throw new Error("/task edit requires at least one of --title, --due, --cat.");
    }
    return { action, match, title, due, cat };
  }

  const match = positional.join(" ").trim();
  if (!match) {
    throw new Error(`/task ${action} requires match text.`);
  }
  return { action, match };
}

function categoryTag(cat: string | undefined): string | undefined {
  return cat ? `#${cat}` : undefined;
}

export function buildTaskCommandArgs(input: string | undefined): string[] {
  const parsed = parseTaskCommand(input);
  if (parsed.action === "add") {
    const parts = [parsed.title];
    if (parsed.due) {
      parts.push(parsed.due);
    }
    const tag = categoryTag(parsed.cat);
    if (tag) {
      parts.push(tag);
    }
    return ["append", "--kind", "plan", "--text", parts.filter(Boolean).join("；")];
  }
  if (parsed.action === "done" || parsed.action === "cancel") {
    return [
      "task-update",
      "--match",
      parsed.match ?? "",
      "--status",
      parsed.action === "done" ? "done" : "cancelled",
    ];
  }
  if (parsed.action === "edit") {
    const args = ["task-edit", "--match", parsed.match ?? ""];
    if (parsed.title) {
      args.push("--title", parsed.title);
    }
    if (parsed.due) {
      args.push("--due", parsed.due);
    }
    if (parsed.cat) {
      args.push("--category", parsed.cat);
    }
    return args;
  }
  const args = ["tasks", "--group", "board"];
  if (parsed.cat) {
    args.push("--category", parsed.cat);
  }
  return args;
}

function resolveWorkspaceRoot(config: OpenClawConfig): string {
  const agents = (config as { agents?: { defaults?: { workspace?: unknown } } }).agents;
  return typeof agents?.defaults?.workspace === "string" && agents.defaults.workspace.trim()
    ? agents.defaults.workspace
    : DEFAULT_WORKSPACE;
}

export async function handleTaskCommand(ctx: PluginCommandContext): Promise<PluginCommandResult> {
  let commandArgs: string[];
  try {
    commandArgs = buildTaskCommandArgs(ctx.args);
  } catch (error) {
    return { text: `❌ ${(error as Error).message}` };
  }

  const workspaceRoot = resolveWorkspaceRoot(ctx.config);
  const wrapper = path.join(workspaceRoot, "scripts", "obsidian-daily.sh");
  try {
    const result = await execFileAsync(wrapper, commandArgs, {
      cwd: workspaceRoot,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    const output = (result.stdout || result.stderr || "✅ Done.").trim();
    return { text: output || "✅ Done." };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string };
    const detail = (err.stderr || err.stdout || err.message).trim();
    return { text: `❌ ${detail || "Task command failed."}`, isError: true };
  }
}
