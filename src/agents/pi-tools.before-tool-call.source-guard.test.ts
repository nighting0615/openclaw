import { describe, expect, it } from "vitest";
import { __testing } from "./pi-tools.before-tool-call.js";

const { runBeforeToolCallHook } = __testing;

describe("runBeforeToolCallHook integration with source-change-guard", () => {
  it("blocks edit tool targeting protected source path", async () => {
    const outcome = await runBeforeToolCallHook({
      toolName: "edit",
      params: {
        path: "/Users/ai/openclaw/src/openclaw/src/agents/source-change-guard.ts",
        edits: [{ oldText: "import path", newText: "// hello" }],
      },
    });
    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) {
      expect(outcome.reason).toMatch(/Source-layer change blocked/);
    }
  });

  it("blocks write tool targeting protected extensions path", async () => {
    const outcome = await runBeforeToolCallHook({
      toolName: "write",
      params: {
        path: "/Users/ai/openclaw/src/openclaw/extensions/telegram/src/foo.ts",
        content: "x",
      },
    });
    expect(outcome.blocked).toBe(true);
  });

  it("allows edit tool targeting workspace path", async () => {
    const outcome = await runBeforeToolCallHook({
      toolName: "edit",
      params: {
        path: "/Users/ai/openclaw/workspaces/main/STATUS.md",
        edits: [{ oldText: "a", newText: "b" }],
      },
    });
    expect(outcome.blocked).toBe(false);
  });

  it("allows non-mutation tools regardless of path", async () => {
    const outcome = await runBeforeToolCallHook({
      toolName: "read",
      params: { path: "/Users/ai/openclaw/src/openclaw/src/agents/source-change-guard.ts" },
    });
    expect(outcome.blocked).toBe(false);
  });

  it("blocks exec redirect into protected source path", async () => {
    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: {
        command: "echo hi > /Users/ai/openclaw/src/openclaw/src/agents/foo.ts",
      },
    });
    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) {
      expect(outcome.reason).toMatch(/Detected write to/);
    }
  });

  it("allows exec reading from protected source path", async () => {
    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: {
        command: "cat /Users/ai/openclaw/src/openclaw/src/agents/source-change-guard.ts",
      },
    });
    expect(outcome.blocked).toBe(false);
  });
});
