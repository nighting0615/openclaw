import syncFs from "node:fs";
import path from "node:path";
import {
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_USER_FILENAME,
  type WorkspaceBootstrapFile,
  type WorkspaceBootstrapFileName,
} from "../../../agents/workspace.js";
import { openRootFile } from "../../../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { isCronSessionKey, isSubagentSessionKey } from "../../../routing/session-key.js";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "../../../shared/string-coerce.js";
import { normalizeSingleOrTrimmedStringList } from "../../../shared/string-normalization.js";
import { resolveUserPath } from "../../../utils.js";
import { resolveHookConfig } from "../../config.js";
import {
  isAgentBootstrapEvent,
  type AgentBootstrapHookContext,
  type HookHandler,
} from "../../hooks.js";

const HOOK_KEY = "family-profile-bootstrap";
const MAX_PROFILE_FILE_BYTES = 256 * 1024;
const DEFAULT_PROFILE_FILE_PATTERNS = [
  "memory/people/{profile}.md",
  "memory/people-policies/{profile}.md",
  "memory/people-summaries/{profile}-latest.md",
];
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const TELEGRAM_DIRECT_SESSION_RE = /^agent:[^:]+:telegram:direct:([^:]+)$/u;
const log = createSubsystemLogger("family-profile-bootstrap");

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeProfileId(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized || !PROFILE_ID_RE.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function resolveSenderProfileMap(hookConfig: Record<string, unknown>): Map<string, string> {
  const configured =
    hookConfig.senderProfiles ?? hookConfig.profilesBySender ?? hookConfig.profileBySenderId;
  if (!isRecord(configured)) {
    return new Map();
  }

  const result = new Map<string, string>();
  for (const [rawSenderId, rawProfileId] of Object.entries(configured)) {
    const senderId = normalizeOptionalString(rawSenderId);
    const profileId = normalizeProfileId(rawProfileId);
    if (senderId && profileId) {
      result.set(senderId, profileId);
    }
  }
  return result;
}

function resolveFilePatterns(hookConfig: Record<string, unknown>): string[] {
  for (const key of ["files", "paths", "patterns", "profileFiles"]) {
    const patterns = normalizeSingleOrTrimmedStringList(hookConfig[key]);
    if (patterns.length > 0) {
      return patterns;
    }
  }
  return DEFAULT_PROFILE_FILE_PATTERNS;
}

function resolveSessionKey(context: AgentBootstrapHookContext): string | undefined {
  return normalizeOptionalString(context.sessionKey) ?? normalizeOptionalString(context.sessionId);
}

function shouldSkipSession(context: AgentBootstrapHookContext): boolean {
  const sessionKey = resolveSessionKey(context);
  return !!sessionKey && (isSubagentSessionKey(sessionKey) || isCronSessionKey(sessionKey));
}

function resolveTelegramDirectSenderId(context: AgentBootstrapHookContext): string | undefined {
  const sessionKey = resolveSessionKey(context);
  const match = sessionKey?.match(TELEGRAM_DIRECT_SESSION_RE);
  return normalizeOptionalString(match?.[1]);
}

function resolveSenderId(context: AgentBootstrapHookContext): string | undefined {
  return (
    normalizeStringifiedOptionalString(context.senderId) ?? resolveTelegramDirectSenderId(context)
  );
}

function workspaceGateAllows(
  context: AgentBootstrapHookContext,
  hookConfig: Record<string, unknown>,
): boolean {
  const configuredWorkspace =
    normalizeOptionalString(hookConfig.workspace) ??
    normalizeOptionalString(hookConfig.workspaceDir);
  if (!configuredWorkspace) {
    return true;
  }
  return (
    path.resolve(resolveUserPath(configuredWorkspace)) ===
    path.resolve(resolveUserPath(context.workspaceDir))
  );
}

function materializeProfilePath(pattern: string, profileId: string): string | undefined {
  const materialized = pattern
    .replaceAll("{profile}", profileId)
    .replaceAll("{profileId}", profileId);
  const normalized = normalizeOptionalString(materialized);
  if (!normalized || path.isAbsolute(normalized) || normalized.startsWith("~")) {
    return undefined;
  }
  return normalized;
}

function bootstrapNameForProfilePath(relativePath: string): WorkspaceBootstrapFileName {
  const normalized = relativePath.split(path.sep).join("/");
  return normalized.includes("/people-summaries/")
    ? DEFAULT_MEMORY_FILENAME
    : DEFAULT_USER_FILENAME;
}

function resolveExistingPathKeys(
  files: WorkspaceBootstrapFile[],
  workspaceRoot: string,
): Set<string> {
  const keys = new Set<string>();
  for (const file of files) {
    const pathValue = normalizeOptionalString(file.path);
    if (!pathValue) {
      continue;
    }
    const resolved = path.isAbsolute(pathValue)
      ? path.resolve(pathValue)
      : path.resolve(workspaceRoot, pathValue);
    keys.add(path.normalize(resolved));
  }
  return keys;
}

async function readProfileBootstrapFile(params: {
  workspaceRoot: string;
  relativePath: string;
}): Promise<WorkspaceBootstrapFile | null> {
  const absolutePath = path.resolve(params.workspaceRoot, params.relativePath);
  const opened = await openRootFile({
    absolutePath,
    rootPath: params.workspaceRoot,
    boundaryLabel: "workspace root",
    maxBytes: MAX_PROFILE_FILE_BYTES,
  });
  if (!opened.ok) {
    return null;
  }

  try {
    return {
      name: bootstrapNameForProfilePath(params.relativePath),
      path: opened.path,
      content: syncFs.readFileSync(opened.fd, "utf-8"),
      missing: false,
    };
  } finally {
    syncFs.closeSync(opened.fd);
  }
}

export const familyProfileBootstrapHook: HookHandler = async (event) => {
  if (!isAgentBootstrapEvent(event)) {
    return;
  }

  const context = event.context;
  const hookConfig = resolveHookConfig(context.cfg, HOOK_KEY);
  if (!hookConfig || hookConfig.enabled === false || shouldSkipSession(context)) {
    return;
  }
  if (!workspaceGateAllows(context, hookConfig as Record<string, unknown>)) {
    return;
  }

  const senderId = resolveSenderId(context);
  if (!senderId) {
    return;
  }

  const profileId = resolveSenderProfileMap(hookConfig as Record<string, unknown>).get(senderId);
  if (!profileId) {
    return;
  }

  const workspaceRoot = path.resolve(resolveUserPath(context.workspaceDir));
  const existing = resolveExistingPathKeys(context.bootstrapFiles, workspaceRoot);
  const additions: WorkspaceBootstrapFile[] = [];
  for (const pattern of resolveFilePatterns(hookConfig as Record<string, unknown>)) {
    const relativePath = materializeProfilePath(pattern, profileId);
    if (!relativePath) {
      continue;
    }
    const absoluteKey = path.normalize(path.resolve(workspaceRoot, relativePath));
    if (existing.has(absoluteKey)) {
      continue;
    }
    const loaded = await readProfileBootstrapFile({ workspaceRoot, relativePath });
    if (!loaded) {
      continue;
    }
    existing.add(path.normalize(loaded.path));
    additions.push(loaded);
  }

  if (additions.length === 0) {
    return;
  }
  context.bootstrapFiles = [...context.bootstrapFiles, ...additions];
  log.debug("injected family profile bootstrap files", {
    senderId,
    profileId,
    files: additions.length,
  });
};

export default familyProfileBootstrapHook;
