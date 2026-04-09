import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/config.js";

type FamilyCapabilityManifest = {
  policy?: {
    labels?: unknown;
    allowed_product_wrappers?: unknown;
    blocked_resources?: unknown;
  };
};

export type ResolvedFamilyCapabilityPolicy = {
  labels: string[];
  allowedProductWrappers: string[];
  blockedResources: string[];
};

const BLOCKED_FAMILY_SHELL_CONTROL_TOKENS = new Set(["|", "||", "&&", ";", ";;", "&"]);
const BLOCKED_FAMILY_WRAPPER_DISCOVERY_TOKENS = new Set(["--help", "-h", "help"]);

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function resolveCapabilityManifestPath(agentId: string): string | null {
  const cfg = loadConfig();
  const rootWorkspace = cfg.agents?.defaults?.workspace?.trim();
  if (rootWorkspace) {
    return path.resolve(rootWorkspace, "config", "capabilities", `${agentId}.json`);
  }

  const entry = Array.isArray(cfg.agents?.list)
    ? cfg.agents.list.find((item) => item?.id === agentId)
    : undefined;
  const agentWorkspace = entry?.workspace?.trim();
  if (!agentWorkspace) {
    return null;
  }
  return path.resolve(agentWorkspace, "..", "config", "capabilities", `${agentId}.json`);
}

export async function readFamilyCapabilityPolicy(
  agentId: string | undefined,
): Promise<ResolvedFamilyCapabilityPolicy | null> {
  const normalizedAgentId = (agentId ?? "").trim().toLowerCase();
  if (!normalizedAgentId) {
    return null;
  }
  const manifestPath = resolveCapabilityManifestPath(normalizedAgentId);
  if (!manifestPath) {
    return null;
  }
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as FamilyCapabilityManifest;
    return {
      labels: normalizeStringList(manifest.policy?.labels),
      allowedProductWrappers: normalizeStringList(manifest.policy?.allowed_product_wrappers),
      blockedResources: normalizeStringList(manifest.policy?.blocked_resources),
    };
  } catch {
    return null;
  }
}

export function commandMatchesAllowedProductWrapper(params: {
  command: string;
  workspaceDir: string;
  allowedProductWrappers: string[];
  argv?: string[] | null;
}): boolean {
  const allowed = new Set(
    params.allowedProductWrappers.flatMap((entry) => {
      const trimmed = entry.trim();
      if (!trimmed) {
        return [];
      }
      const resolved = path.resolve(params.workspaceDir, trimmed);
      return [trimmed, resolved, path.basename(trimmed)];
    }),
  );
  if (allowed.size === 0) {
    return false;
  }
  const tokens = params.argv ?? [];
  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) {
      continue;
    }
    if (allowed.has(trimmed)) {
      return true;
    }
    const resolved = path.isAbsolute(trimmed)
      ? path.resolve(trimmed)
      : path.resolve(params.workspaceDir, trimmed);
    if (allowed.has(resolved) || allowed.has(path.basename(trimmed))) {
      return true;
    }
  }
  return false;
}

export function commandUsesBlockedFamilyShellSyntax(params: {
  command: string;
  argv?: string[] | null;
}): boolean {
  if (typeof params.command === "string" && /[\r\n]/u.test(params.command)) {
    return true;
  }
  const tokens = params.argv ?? [];
  return tokens.some((token) => BLOCKED_FAMILY_SHELL_CONTROL_TOKENS.has(token.trim()));
}

export function commandUsesBlockedFamilyWrapperDiscovery(params: {
  argv?: string[] | null;
}): boolean {
  const tokens = params.argv ?? [];
  return tokens.some((token) =>
    BLOCKED_FAMILY_WRAPPER_DISCOVERY_TOKENS.has(token.trim().toLowerCase()),
  );
}

export async function evaluateFamilyRawExecPolicy(params: {
  agentId?: string;
  command: string;
  workspaceDir: string;
  argv?: string[] | null;
}): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const policy = await readFamilyCapabilityPolicy(params.agentId);
  if (!policy || !policy.labels.includes("no_raw_exec_for_family")) {
    return { allowed: true };
  }
  if (
    commandMatchesAllowedProductWrapper({
      command: params.command,
      workspaceDir: params.workspaceDir,
      allowedProductWrappers: policy.allowedProductWrappers,
      argv: params.argv,
    })
  ) {
    if (commandUsesBlockedFamilyShellSyntax({ command: params.command, argv: params.argv })) {
      return {
        allowed: false,
        reason:
          "exec denied: family product wrappers must be invoked directly; shell control operators are blocked.",
      };
    }
    if (commandUsesBlockedFamilyWrapperDiscovery({ argv: params.argv })) {
      return {
        allowed: false,
        reason:
          "exec denied: family product wrappers must use direct product subcommands; help/discovery invocations are blocked.",
      };
    }
    return { allowed: true };
  }
  return {
    allowed: false,
    reason:
      "exec denied: this family workspace may use approved product wrappers only; raw exec is blocked.",
  };
}

function pathLooksLikeBlockedRecurringDatesState(targetPath: string): boolean {
  const normalized = targetPath.replaceAll("\\", "/").toLowerCase();
  return normalized.includes("/state/openclaw/recurring-dates/");
}

function pathLooksLikeBlockedRawSessionTranscript(targetPath: string): boolean {
  const normalized = targetPath.replaceAll("\\", "/").toLowerCase();
  return (
    /\/state\/openclaw\/agents\/[^/]+\/sessions\/.+\.jsonl(?:\.deleted\..+)?$/u.test(normalized) ||
    /\/state\/openclaw\/session-reset-backups\/.+\.jsonl$/u.test(normalized)
  );
}

export async function evaluateFamilyFileReadPolicy(params: {
  agentId?: string;
  targetPath: string;
}): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const policy = await readFamilyCapabilityPolicy(params.agentId);
  if (!policy || !policy.labels.includes("no_raw_exec_for_family")) {
    return { allowed: true };
  }
  const blocked = new Set(policy.blockedResources.map((entry) => entry.trim().toLowerCase()));
  if (
    blocked.has("owner-recurring-dates") &&
    pathLooksLikeBlockedRecurringDatesState(params.targetPath)
  ) {
    return {
      allowed: false,
      reason:
        "read denied: this family workspace cannot access the owner's recurring reminder data; do not offer recurring-date add/edit/delete here; suggest shared tasks or explicit personal todos instead.",
    };
  }
  if (
    blocked.has("raw-chat-history-transcripts") &&
    pathLooksLikeBlockedRawSessionTranscript(params.targetPath)
  ) {
    return {
      allowed: false,
      reason:
        "read denied: family chat-history requests must use the chat-history wrapper; do not read raw session transcripts directly.",
    };
  }
  return { allowed: true };
}

export async function sanitizeExecResultTextForFamilySurface(params: {
  agentId?: string;
  resultText: string;
}): Promise<string> {
  const trimmed = params.resultText.trim();
  if (!trimmed) {
    return trimmed;
  }
  const policy = await readFamilyCapabilityPolicy(params.agentId);
  if (!policy || !policy.labels.includes("no_raw_exec_for_family")) {
    return trimmed;
  }
  if (!trimmed.startsWith("Exec denied (")) {
    return trimmed;
  }
  if (trimmed.includes("approval-timeout")) {
    return "系统命令未执行：需要额外批准，但批准流程未完成。";
  }
  if (trimmed.includes("approval-request-failed")) {
    return "系统命令未执行：批准请求发送失败，未继续运行。";
  }
  if (trimmed.includes("user-denied")) {
    return "系统命令未执行：批准被拒绝。";
  }
  if (trimmed.includes("allowlist-miss")) {
    return "系统命令未执行：当前会话没有权限直接运行该系统命令。";
  }
  return "系统命令未执行：被安全策略拦截。";
}
