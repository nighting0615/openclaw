import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: {
      defaults: {
        workspace: "/Users/ai/openclaw/workspaces/main",
      },
    },
  })),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(async (target: string) => {
      if (target.endsWith("/ray.json")) {
        return JSON.stringify({
          policy: {
            labels: ["no_raw_exec_for_family"],
            allowed_product_wrappers: ["scripts/seedance.sh", "scripts/image-gen.sh"],
            blocked_resources: ["owner-recurring-dates", "raw-chat-history-transcripts"],
          },
        });
      }
      throw new Error("manifest not found");
    }),
  },
}));

import {
  commandMatchesAllowedProductWrapper,
  commandUsesBlockedFamilyShellSyntax,
  commandUsesBlockedFamilyWrapperDiscovery,
  evaluateFamilyFileReadPolicy,
  evaluateFamilyRawExecPolicy,
  sanitizeExecResultTextForFamilySurface,
} from "./family-capability-policy.js";

describe("family capability policy helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("matches allowed wrappers by relative path, absolute path, or basename", () => {
    const workspaceDir = "/Users/ai/openclaw/workspaces/main";
    const allowed = ["scripts/seedance.sh", "scripts/image-gen.sh"];

    expect(
      commandMatchesAllowedProductWrapper({
        command: "bash scripts/seedance.sh generate --prompt hi",
        workspaceDir,
        allowedProductWrappers: allowed,
        argv: ["bash", "scripts/seedance.sh", "generate", "--prompt", "hi"],
      }),
    ).toBe(true);
    expect(
      commandMatchesAllowedProductWrapper({
        command:
          "bash /Users/ai/openclaw/workspaces/main/scripts/image-gen.sh generate --prompt hi",
        workspaceDir,
        allowedProductWrappers: allowed,
        argv: [
          "bash",
          "/Users/ai/openclaw/workspaces/main/scripts/image-gen.sh",
          "generate",
          "--prompt",
          "hi",
        ],
      }),
    ).toBe(true);
    expect(
      commandMatchesAllowedProductWrapper({
        command: "python3 - <<'PY'",
        workspaceDir,
        allowedProductWrappers: allowed,
        argv: ["python3", "-"],
      }),
    ).toBe(false);
  });

  it("treats shell control operators as blocked family wrapper syntax", () => {
    expect(
      commandUsesBlockedFamilyShellSyntax({
        command:
          "bash /Users/ai/openclaw/workspaces/main/scripts/recurring-dates.sh --help || bash /Users/ai/openclaw/workspaces/main/scripts/recurring-dates.sh help",
        argv: [
          "bash",
          "/Users/ai/openclaw/workspaces/main/scripts/recurring-dates.sh",
          "--help",
          "||",
          "bash",
          "/Users/ai/openclaw/workspaces/main/scripts/recurring-dates.sh",
          "help",
        ],
      }),
    ).toBe(true);
    expect(
      commandUsesBlockedFamilyShellSyntax({
        command: "bash /Users/ai/openclaw/workspaces/main/scripts/seedance.sh generate --prompt hi",
        argv: [
          "bash",
          "/Users/ai/openclaw/workspaces/main/scripts/seedance.sh",
          "generate",
          "--prompt",
          "hi",
        ],
      }),
    ).toBe(false);
  });

  it("treats help-style discovery as blocked family wrapper syntax", () => {
    expect(
      commandUsesBlockedFamilyWrapperDiscovery({
        argv: ["bash", "/Users/ai/openclaw/workspaces/main/scripts/recurring-dates.sh", "--help"],
      }),
    ).toBe(true);
    expect(
      commandUsesBlockedFamilyWrapperDiscovery({
        argv: ["bash", "/Users/ai/openclaw/workspaces/main/scripts/recurring-dates.sh", "help"],
      }),
    ).toBe(true);
    expect(
      commandUsesBlockedFamilyWrapperDiscovery({
        argv: [
          "bash",
          "/Users/ai/openclaw/workspaces/main/scripts/seedance.sh",
          "generate",
          "--prompt",
          "hi",
        ],
      }),
    ).toBe(false);
  });

  it("denies family wrapper commands that chain with shell control operators", async () => {
    await expect(
      evaluateFamilyRawExecPolicy({
        agentId: "ray",
        command:
          "bash /Users/ai/openclaw/workspaces/main/scripts/image-gen.sh --help || bash /Users/ai/openclaw/workspaces/main/scripts/image-gen.sh help",
        workspaceDir: "/Users/ai/openclaw/workspaces/main",
        argv: [
          "bash",
          "/Users/ai/openclaw/workspaces/main/scripts/image-gen.sh",
          "--help",
          "||",
          "bash",
          "/Users/ai/openclaw/workspaces/main/scripts/image-gen.sh",
          "help",
        ],
      }),
    ).resolves.toEqual({
      allowed: false,
      reason:
        "exec denied: family product wrappers must be invoked directly; shell control operators are blocked.",
    });
  });

  it("denies family wrapper help/discovery invocations", async () => {
    await expect(
      evaluateFamilyRawExecPolicy({
        agentId: "ray",
        command: "bash /Users/ai/openclaw/workspaces/main/scripts/image-gen.sh --help",
        workspaceDir: "/Users/ai/openclaw/workspaces/main",
        argv: ["bash", "/Users/ai/openclaw/workspaces/main/scripts/image-gen.sh", "--help"],
      }),
    ).resolves.toEqual({
      allowed: false,
      reason:
        "exec denied: family product wrappers must use direct product subcommands; help/discovery invocations are blocked.",
    });
  });

  it("keeps generic denied text untouched when no family manifest is found", async () => {
    await expect(
      sanitizeExecResultTextForFamilySurface({
        agentId: "unknown-agent",
        resultText: "Exec denied (gateway id=req-1, user-denied): uname -a",
      }),
    ).resolves.toBe("Exec denied (gateway id=req-1, user-denied): uname -a");
  });

  it("denies family reads of owner recurring-date state", async () => {
    await expect(
      evaluateFamilyFileReadPolicy({
        agentId: "ray",
        targetPath: "/Users/ai/openclaw/state/openclaw/recurring-dates/dates.json",
      }),
    ).resolves.toEqual({
      allowed: false,
      reason:
        "read denied: this family workspace cannot access the owner's recurring reminder data; do not offer recurring-date add/edit/delete here; suggest shared tasks or explicit personal todos instead.",
    });
  });

  it("allows family reads outside blocked owner data", async () => {
    await expect(
      evaluateFamilyFileReadPolicy({
        agentId: "ray",
        targetPath: "/Users/ai/openclaw/workspaces/main/ray/todos.md",
      }),
    ).resolves.toEqual({ allowed: true });
  });

  it("denies direct family reads of raw session transcripts", async () => {
    await expect(
      evaluateFamilyFileReadPolicy({
        agentId: "ray",
        targetPath:
          "/Users/ai/openclaw/state/openclaw/agents/ray/sessions/30ae3f68-ac99-4588-94d1-b44b4b6fc2e0.jsonl",
      }),
    ).resolves.toEqual({
      allowed: false,
      reason:
        "read denied: family chat-history requests must use the chat-history wrapper; do not read raw session transcripts directly.",
    });
  });

  it("sanitizes denied text for ray family surfaces", async () => {
    await expect(
      sanitizeExecResultTextForFamilySurface({
        agentId: "ray",
        resultText: "Exec denied (gateway id=req-1, approval-timeout): python3 <<'PY' ...",
      }),
    ).resolves.toBe("系统命令未执行：需要额外批准，但批准流程未完成。");
  });
});
