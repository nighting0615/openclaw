import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { OpenClawConfig, PluginCommandContext, PluginCommandResult } from "../runtime-api.js";

const execFileAsync = promisify(execFile);

const DEFAULT_WORKSPACE = "/Users/ai/openclaw/workspaces/main";

const DIARY_SUBCOMMANDS = {
  thought: "thought",
  idea: "thought",
  想法: "thought",
  achievement: "achievement",
  achieve: "achievement",
  成就: "achievement",
  weight: "weight",
  体重: "weight",
  mood: "mood",
  情绪: "mood",
  synopsis: "synopsis",
  梗概: "synopsis",
  habit: "habit",
  打卡: "habit",
} as const;

const HABIT_NAMES = {
  exercise: "exercise",
  workout: "exercise",
  锻炼: "exercise",
  锻炼完成: "exercise",
  english: "english",
  英语: "english",
  英语完成: "english",
  reading: "reading",
  read: "reading",
  读书: "reading",
  读书完成: "reading",
  sleep: "sleep",
  早睡: "sleep",
  早睡完成: "sleep",
} as const;

type DiarySubcommand = (typeof DIARY_SUBCOMMANDS)[keyof typeof DIARY_SUBCOMMANDS];
type HabitName = (typeof HABIT_NAMES)[keyof typeof HABIT_NAMES];

function firstToken(input: string | undefined): { token: string; rest: string } {
  const raw = (input ?? "").trim();
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(raw);
  if (!match) {
    return { token: "", rest: "" };
  }
  return { token: match[1], rest: (match[2] ?? "").trim() };
}

function normalizeKey(value: string): string {
  return /^[\x00-\x7F]+$/u.test(value) ? value.toLowerCase() : value;
}

function normalizeDiarySubcommand(value: string): DiarySubcommand | undefined {
  return DIARY_SUBCOMMANDS[normalizeKey(value) as keyof typeof DIARY_SUBCOMMANDS];
}

function normalizeHabitName(value: string): HabitName | undefined {
  return HABIT_NAMES[normalizeKey(value) as keyof typeof HABIT_NAMES];
}

function timestampArgs(timestamp?: number): string[] {
  return Number.isFinite(timestamp) ? ["--at", String(timestamp)] : [];
}

export function buildHabitCommandArgs(input: string | undefined, timestamp?: number): string[] {
  const { token, rest } = firstToken(input);
  if (!token || rest) {
    throw new Error("Usage: /habit exercise|english|reading|sleep");
  }
  const habitName = normalizeHabitName(token);
  if (!habitName) {
    throw new Error("Usage: /habit exercise|english|reading|sleep");
  }
  return ["habit", "--name", habitName, ...timestampArgs(timestamp)];
}

export function buildDiaryCommandArgs(input: string | undefined, timestamp?: number): string[] {
  const { token, rest } = firstToken(input);
  const subcommand = normalizeDiarySubcommand(token);
  if (!subcommand) {
    throw new Error(
      "Usage: /diary thought|achievement|weight|mood|synopsis <text> or /diary habit <name>",
    );
  }
  if (!rest) {
    throw new Error(`/diary ${token} requires content.`);
  }

  if (subcommand === "habit") {
    return buildHabitCommandArgs(rest, timestamp);
  }
  if (subcommand === "thought" || subcommand === "achievement") {
    return ["append", "--kind", subcommand, "--text", rest, ...timestampArgs(timestamp)];
  }
  return [subcommand, "--value", rest, ...timestampArgs(timestamp)];
}

function resolveWorkspaceRoot(config: OpenClawConfig): string {
  const agents = (config as { agents?: { defaults?: { workspace?: unknown } } }).agents;
  return typeof agents?.defaults?.workspace === "string" && agents.defaults.workspace.trim()
    ? agents.defaults.workspace
    : DEFAULT_WORKSPACE;
}

async function executeObsidianDailyCommand(
  ctx: PluginCommandContext,
  commandArgs: string[],
  fallbackMessage: string,
): Promise<PluginCommandResult> {
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
    return { text: `❌ ${detail || fallbackMessage}`, isError: true };
  }
}

export async function handleDiaryCommand(ctx: PluginCommandContext): Promise<PluginCommandResult> {
  let commandArgs: string[];
  try {
    commandArgs = buildDiaryCommandArgs(ctx.args, ctx.timestamp);
  } catch (error) {
    return { text: `❌ ${(error as Error).message}` };
  }
  return executeObsidianDailyCommand(ctx, commandArgs, "Diary command failed.");
}

export async function handleHabitCommand(ctx: PluginCommandContext): Promise<PluginCommandResult> {
  let commandArgs: string[];
  try {
    commandArgs = buildHabitCommandArgs(ctx.args, ctx.timestamp);
  } catch (error) {
    return { text: `❌ ${(error as Error).message}` };
  }
  return executeObsidianDailyCommand(ctx, commandArgs, "Habit command failed.");
}
