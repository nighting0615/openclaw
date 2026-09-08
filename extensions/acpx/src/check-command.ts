import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { OpenClawConfig, PluginCommandContext, PluginCommandResult } from "../runtime-api.js";

const execFileAsync = promisify(execFile);
const DEFAULT_WORKSPACE = "/Users/ai/openclaw/workspaces/main";

type Token = { value: string; quoted: boolean };

function tokenizeArgs(input: string): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
    } else if (/\s/u.test(char)) {
      if (current || quoted) {
        tokens.push({ value: current, quoted });
        current = "";
        quoted = false;
      }
    } else {
      current += char;
    }
  }
  if (quote) {
    throw new Error("Unclosed quote.");
  }
  if (current || quoted) {
    tokens.push({ value: current, quoted });
  }
  return tokens;
}

function normalizeOptionToken(value: string): string {
  return value
    .replace(/^[\u2013\u2014\u2015\u2212\uFF0D]{1,2}/u, "--")
    .replace(/^-{1}(?=[A-Za-z])/u, "--");
}

function isOption(value: string): boolean {
  return normalizeOptionToken(value).startsWith("--");
}

function optionValue(tokens: Token[], index: number, option: string): string {
  const value = tokens[index + 1]?.value;
  if (!value || isOption(value)) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function requireText(value: string, usage: string): string {
  const text = value.trim();
  if (!text) {
    throw new Error(usage);
  }
  return text;
}

type ParsedCheckCommand =
  | { action: "help" | "list"; templates?: boolean }
  | { action: "add"; title: string; template: boolean }
  | { action: "edit"; match: string; title: string }
  | { action: "remove"; id: string }
  | { action: "item-add"; checklistId: string; title: string; due?: string; priority: boolean }
  | {
      action: "item-edit";
      checklistId: string;
      itemId: string;
      title?: string;
      due?: string;
      noDue: boolean;
      priority?: 0 | 1;
    }
  | { action: "item-remove"; checklistId: string; itemId: string };

function parseCheckCommand(input: string | undefined): ParsedCheckCommand {
  const tokens = tokenizeArgs((input ?? "").trim());
  const verb = tokens.shift()?.value;
  if (!verb || verb === "help") {
    if (verb && tokens.length) {
      throw new Error("Usage: /raycheck help");
    }
    return { action: "help" };
  }
  if (verb === "list") {
    const scope = tokens.shift()?.value;
    if (scope && scope !== "templates") {
      throw new Error("Usage: /raycheck list [templates]");
    }
    if (tokens.length) {
      throw new Error("Usage: /raycheck list [templates]");
    }
    return { action: "list", templates: scope === "templates" };
  }
  if (verb === "add") {
    const positional: string[] = [];
    let template = false;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = normalizeOptionToken(tokens[index].value);
      if (token === "--template") {
        template = true;
      } else if (isOption(token)) {
        throw new Error(`Unknown option: ${token}`);
      } else {
        positional.push(tokens[index].value);
      }
    }
    return {
      action: "add",
      title: requireText(positional.join(" "), "Usage: /raycheck add <title> [--template]"),
      template,
    };
  }
  if (verb === "edit") {
    const positional: string[] = [];
    let title: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = normalizeOptionToken(tokens[index].value);
      if (token === "--title") {
        title = optionValue(tokens, index, "--title");
        index += 1;
      } else if (isOption(token)) {
        throw new Error(`Unknown option: ${token}`);
      } else {
        positional.push(tokens[index].value);
      }
    }
    return {
      action: "edit",
      match: requireText(
        positional.join(" "),
        "Usage: /raycheck edit <id-or-title> --title <new title>",
      ),
      title: requireText(title ?? "", "Usage: /raycheck edit <id-or-title> --title <new title>"),
    };
  }
  if (verb === "remove") {
    if (tokens.length !== 1 || isOption(tokens[0].value)) {
      throw new Error("Usage: /raycheck remove <checklist-id>");
    }
    return { action: "remove", id: tokens[0].value };
  }
  if (verb !== "item") {
    throw new Error("Usage: /raycheck help");
  }

  const itemVerb = tokens.shift()?.value;
  if (itemVerb === "add") {
    const positional: string[] = [];
    let due: string | undefined;
    let priority = false;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = normalizeOptionToken(tokens[index].value);
      if (token === "--due") {
        due = optionValue(tokens, index, "--due");
        index += 1;
      } else if (token === "--priority") {
        priority = true;
      } else if (isOption(token)) {
        throw new Error(`Unknown option: ${token}`);
      } else {
        positional.push(tokens[index].value);
      }
    }
    if (positional.length < 2) {
      throw new Error(
        "Usage: /raycheck item add <checklist-id> <title> [--due YYYY-MM-DD] [--priority]",
      );
    }
    return {
      action: "item-add",
      checklistId: positional[0],
      title: requireText(
        positional.slice(1).join(" "),
        "Usage: /raycheck item add <checklist-id> <title>",
      ),
      due,
      priority,
    };
  }
  if (itemVerb === "edit") {
    const checklistId = tokens.shift()?.value;
    const itemId = tokens.shift()?.value;
    if (!checklistId || !itemId || isOption(checklistId) || isOption(itemId)) {
      throw new Error("Usage: /raycheck item edit <checklist-id> <item-id> ...");
    }
    let title: string | undefined;
    let due: string | undefined;
    let noDue = false;
    let priority: 0 | 1 | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = normalizeOptionToken(tokens[index].value);
      if (token === "--title") {
        title = optionValue(tokens, index, "--title");
        index += 1;
      } else if (token === "--due") {
        if (noDue) {
          throw new Error("--due and --no-due cannot be combined.");
        }
        due = optionValue(tokens, index, "--due");
        index += 1;
      } else if (token === "--no-due") {
        if (due !== undefined) {
          throw new Error("--due and --no-due cannot be combined.");
        }
        noDue = true;
      } else if (token === "--priority") {
        if (priority !== undefined) {
          throw new Error("--priority and --normal cannot be combined.");
        }
        priority = 1;
      } else if (token === "--normal") {
        if (priority !== undefined) {
          throw new Error("--priority and --normal cannot be combined.");
        }
        priority = 0;
      } else {
        throw new Error(`Unknown option: ${token}`);
      }
    }
    if (title === undefined && due === undefined && !noDue && priority === undefined) {
      throw new Error("/raycheck item edit requires at least one field option.");
    }
    return { action: "item-edit", checklistId, itemId, title, due, noDue, priority };
  }
  if (itemVerb === "remove") {
    if (tokens.length !== 2 || isOption(tokens[0].value) || isOption(tokens[1].value)) {
      throw new Error("Usage: /raycheck item remove <checklist-id> <item-id>");
    }
    return { action: "item-remove", checklistId: tokens[0].value, itemId: tokens[1].value };
  }
  throw new Error("Usage: /raycheck item add|edit|remove ...");
}

export function buildCheckCommandArgs(input: string | undefined): string[] {
  const parsed = parseCheckCommand(input);
  if (parsed.action === "help") {
    return ["checklist-help"];
  }
  if (parsed.action === "list") {
    return ["checklist-list", ...(parsed.templates ? ["--templates"] : [])];
  }
  if (parsed.action === "add") {
    return ["checklist-add", "--title", parsed.title, ...(parsed.template ? ["--template"] : [])];
  }
  if (parsed.action === "edit") {
    return ["checklist-edit", "--match", parsed.match, "--title", parsed.title];
  }
  if (parsed.action === "remove") {
    return ["checklist-remove", "--id", parsed.id];
  }
  if (parsed.action === "item-add") {
    return [
      "checklist-item-add",
      "--checklist-id",
      parsed.checklistId,
      "--title",
      parsed.title,
      ...(parsed.due ? ["--due", parsed.due] : []),
      ...(parsed.priority ? ["--priority"] : []),
    ];
  }
  if (parsed.action === "item-edit") {
    return [
      "checklist-item-edit",
      "--checklist-id",
      parsed.checklistId,
      "--item-id",
      parsed.itemId,
      ...(parsed.title !== undefined ? ["--title", parsed.title] : []),
      ...(parsed.due !== undefined ? ["--due", parsed.due] : []),
      ...(parsed.noDue ? ["--no-due"] : []),
      ...(parsed.priority === 1 ? ["--priority"] : parsed.priority === 0 ? ["--normal"] : []),
    ];
  }
  return [
    "checklist-item-remove",
    "--checklist-id",
    parsed.checklistId,
    "--item-id",
    parsed.itemId,
  ];
}

function resolveWorkspaceRoot(config: OpenClawConfig): string {
  const agents = (config as { agents?: { defaults?: { workspace?: unknown } } }).agents;
  return typeof agents?.defaults?.workspace === "string" && agents.defaults.workspace.trim()
    ? agents.defaults.workspace
    : DEFAULT_WORKSPACE;
}

export async function handleCheckCommand(ctx: PluginCommandContext): Promise<PluginCommandResult> {
  let commandArgs: string[];
  try {
    commandArgs = buildCheckCommandArgs(ctx.args);
  } catch (error) {
    return { text: `❌ ${(error as Error).message}` };
  }
  const workspaceRoot = resolveWorkspaceRoot(ctx.config);
  const wrapper = path.join(workspaceRoot, "scripts", "papers3-kid.sh");
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
    return { text: `❌ ${detail || "Checklist command failed."}`, isError: true };
  }
}
