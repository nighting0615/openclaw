import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import type { AgentBootstrapHookContext } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";
import handler from "./handler.js";

function createConfig(params?: {
  senderProfiles?: Record<string, string>;
  files?: string[];
  workspace?: string;
}): OpenClawConfig {
  return {
    hooks: {
      internal: {
        entries: {
          "family-profile-bootstrap": {
            enabled: true,
            senderProfiles: params?.senderProfiles ?? {
              "109950863": "naiting",
              "8661349497": "ray",
            },
            ...(params?.files ? { files: params.files } : {}),
            ...(params?.workspace ? { workspace: params.workspace } : {}),
          },
        },
      },
    },
  };
}

async function writeProfileSet(workspaceDir: string, profileId: string): Promise<void> {
  await fs.mkdir(path.join(workspaceDir, "memory", "people"), { recursive: true });
  await fs.mkdir(path.join(workspaceDir, "memory", "people-policies"), { recursive: true });
  await fs.mkdir(path.join(workspaceDir, "memory", "people-summaries"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, "memory", "people", `${profileId}.md`),
    `${profileId} profile`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(workspaceDir, "memory", "people-policies", `${profileId}.md`),
    `${profileId} policy`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(workspaceDir, "memory", "people-summaries", `${profileId}-latest.md`),
    `${profileId} summary`,
    "utf-8",
  );
}

async function createBootstrapContext(params: {
  workspaceDir: string;
  cfg: OpenClawConfig;
  sessionKey: string;
  senderId?: string;
}): Promise<AgentBootstrapHookContext> {
  const userPath = await writeWorkspaceFile({
    dir: params.workspaceDir,
    name: "USER.md",
    content: "root user",
  });
  return {
    workspaceDir: params.workspaceDir,
    bootstrapFiles: [{ name: "USER.md", path: userPath, content: "root user", missing: false }],
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: "main",
    senderId: params.senderId,
  };
}

async function relativeBootstrapPaths(
  context: AgentBootstrapHookContext,
  workspaceDir: string,
): Promise<string[]> {
  const workspaceRealpath = await fs.realpath(workspaceDir);
  return Promise.all(
    context.bootstrapFiles.map(async (file) =>
      path.relative(workspaceRealpath, await fs.realpath(file.path)),
    ),
  );
}

describe("family-profile-bootstrap hook", () => {
  it("injects the mapped profile for a Telegram direct session key", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-family-profile-direct-");
    await writeProfileSet(workspaceDir, "naiting");
    const context = await createBootstrapContext({
      workspaceDir,
      cfg: createConfig(),
      sessionKey: "agent:main:telegram:direct:109950863",
    });

    await handler(createHookEvent("agent", "bootstrap", context.sessionKey ?? "session", context));

    expect(await relativeBootstrapPaths(context, workspaceDir)).toEqual([
      "USER.md",
      path.join("memory", "people", "naiting.md"),
      path.join("memory", "people-policies", "naiting.md"),
      path.join("memory", "people-summaries", "naiting-latest.md"),
    ]);
    expect(context.bootstrapFiles.map((file) => file.content)).toContain("naiting profile");
  });

  it("uses the current sender id for a group session", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-family-profile-group-");
    await writeProfileSet(workspaceDir, "ray");
    const context = await createBootstrapContext({
      workspaceDir,
      cfg: createConfig(),
      sessionKey: "agent:main:telegram:group:-5137556444",
      senderId: "8661349497",
    });

    await handler(createHookEvent("agent", "bootstrap", context.sessionKey ?? "session", context));

    expect(await relativeBootstrapPaths(context, workspaceDir)).toContain(
      path.join("memory", "people", "ray.md"),
    );
    expect(context.bootstrapFiles.map((file) => file.content)).toContain("ray policy");
  });

  it("does not inject files for an unknown sender", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-family-profile-unknown-");
    await writeProfileSet(workspaceDir, "naiting");
    const context = await createBootstrapContext({
      workspaceDir,
      cfg: createConfig(),
      sessionKey: "agent:main:telegram:group:-5137556444",
      senderId: "unknown",
    });

    await handler(createHookEvent("agent", "bootstrap", context.sessionKey ?? "session", context));

    expect(context.bootstrapFiles).toHaveLength(1);
    expect(context.bootstrapFiles[0]?.content).toBe("root user");
  });
});
