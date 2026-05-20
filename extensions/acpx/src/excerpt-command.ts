import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { OpenClawConfig, PluginCommandContext, PluginCommandResult } from "../runtime-api.js";

const execFileAsync = promisify(execFile);

const DEFAULT_WORKSPACE = "/Users/ai/openclaw/workspaces/main";
const SEPARATOR_PATTERN = /[；;]/u;

type ParsedExcerptCommand = {
  title: string;
  text: string;
};

function parseExcerptCommand(input: string | undefined): ParsedExcerptCommand {
  const raw = (input ?? "").trim();
  if (!raw) {
    throw new Error("Usage: /excerpt <书名>；<内容>");
  }
  const match = SEPARATOR_PATTERN.exec(raw);
  if (!match) {
    throw new Error("Usage: /excerpt <书名>；<内容> (用全角；或半角;分隔书名与内容)");
  }
  const title = raw.slice(0, match.index).trim();
  const text = raw.slice(match.index + match[0].length).trim();
  if (!title) {
    throw new Error("/excerpt 缺少书名");
  }
  if (!text) {
    throw new Error("/excerpt 缺少内容");
  }
  return { title, text };
}

export function buildExcerptCommandArgs(input: string | undefined): string[] {
  const parsed = parseExcerptCommand(input);
  return ["book-excerpt", "--title", parsed.title, "--text", parsed.text];
}

function resolveWorkspaceRoot(config: OpenClawConfig): string {
  const agents = (config as { agents?: { defaults?: { workspace?: unknown } } }).agents;
  return typeof agents?.defaults?.workspace === "string" && agents.defaults.workspace.trim()
    ? agents.defaults.workspace
    : DEFAULT_WORKSPACE;
}

export async function handleExcerptCommand(
  ctx: PluginCommandContext,
): Promise<PluginCommandResult> {
  let commandArgs: string[];
  try {
    commandArgs = buildExcerptCommandArgs(ctx.args);
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
    return { text: `❌ ${detail || "Excerpt command failed."}`, isError: true };
  }
}
