import { describe, expect, it } from "vitest";
import { evaluateSourceChangeGuard } from "./source-change-guard.js";

const PROTECTED = [
  "/Users/ai/openclaw/src/openclaw/src",
  "/Users/ai/openclaw/src/openclaw/extensions",
];

describe("evaluateSourceChangeGuard", () => {
  it("blocks edit on protected src path", () => {
    const decision = evaluateSourceChangeGuard({
      toolName: "edit",
      params: {
        path: "/Users/ai/openclaw/src/openclaw/src/agents/foo.ts",
        edits: [{ oldText: "a", newText: "b" }],
      },
      protectedPrefixes: PROTECTED,
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) {
      expect(decision.reason).toMatch(/Source-layer change blocked/);
      expect(decision.reason).toMatch(/foo\.ts/);
    }
  });

  it("blocks edit on protected extensions path", () => {
    const decision = evaluateSourceChangeGuard({
      toolName: "edit",
      params: {
        path: "/Users/ai/openclaw/src/openclaw/extensions/telegram/src/lane-delivery.test.ts",
        edits: [{ oldText: "a", newText: "b" }],
      },
      protectedPrefixes: PROTECTED,
    });
    expect(decision.blocked).toBe(true);
  });

  it("blocks write on protected path", () => {
    const decision = evaluateSourceChangeGuard({
      toolName: "write",
      params: { path: "/Users/ai/openclaw/src/openclaw/src/new-file.ts", content: "x" },
      protectedPrefixes: PROTECTED,
    });
    expect(decision.blocked).toBe(true);
  });

  it("blocks apply_patch with hunk inside protected tree", () => {
    const decision = evaluateSourceChangeGuard({
      toolName: "apply_patch",
      params: {
        input:
          "*** Begin Patch\n" +
          "*** Update File: /Users/ai/openclaw/src/openclaw/src/foo.ts\n" +
          "@@\n" +
          "-old\n" +
          "+new\n" +
          "*** End Patch\n",
      },
      protectedPrefixes: PROTECTED,
    });
    expect(decision.blocked).toBe(true);
  });

  it("normalizes apply-patch alias to apply_patch", () => {
    const decision = evaluateSourceChangeGuard({
      toolName: "apply-patch",
      params: {
        input:
          "*** Begin Patch\n" +
          "*** Add File: /Users/ai/openclaw/src/openclaw/extensions/foo/new.ts\n" +
          "+contents\n" +
          "*** End Patch\n",
      },
      protectedPrefixes: PROTECTED,
    });
    expect(decision.blocked).toBe(true);
  });

  it("allows edit inside workspace", () => {
    const decision = evaluateSourceChangeGuard({
      toolName: "edit",
      params: {
        path: "/Users/ai/openclaw/workspaces/main/STATUS.md",
        edits: [{ oldText: "a", newText: "b" }],
      },
      protectedPrefixes: PROTECTED,
    });
    expect(decision.blocked).toBe(false);
  });

  it("allows edit inside state dir", () => {
    const decision = evaluateSourceChangeGuard({
      toolName: "edit",
      params: {
        path: "/Users/ai/openclaw/state/openclaw/news-aggregator/likes.json",
        edits: [{ oldText: "a", newText: "b" }],
      },
      protectedPrefixes: PROTECTED,
    });
    expect(decision.blocked).toBe(false);
  });

  it("allows non-mutation tools regardless of path", () => {
    const decision = evaluateSourceChangeGuard({
      toolName: "read",
      params: { path: "/Users/ai/openclaw/src/openclaw/src/agents/foo.ts" },
      protectedPrefixes: PROTECTED,
    });
    expect(decision.blocked).toBe(false);
  });

  it("allows exec (out of scope for v1; documented gap)", () => {
    const decision = evaluateSourceChangeGuard({
      toolName: "exec",
      params: {
        cmd: "echo hi > /Users/ai/openclaw/src/openclaw/src/foo.ts",
      },
      protectedPrefixes: PROTECTED,
    });
    expect(decision.blocked).toBe(false);
  });

  it("resolves relative path against cwd before classifying", () => {
    const decision = evaluateSourceChangeGuard({
      toolName: "edit",
      params: {
        path: "agents/foo.ts",
        edits: [{ oldText: "a", newText: "b" }],
      },
      cwd: "/Users/ai/openclaw/src/openclaw/src",
      protectedPrefixes: PROTECTED,
    });
    expect(decision.blocked).toBe(true);
  });

  it("does not block when path param missing", () => {
    const decision = evaluateSourceChangeGuard({
      toolName: "edit",
      params: { edits: [{ oldText: "a", newText: "b" }] },
      protectedPrefixes: PROTECTED,
    });
    expect(decision.blocked).toBe(false);
  });

  it("does not block apply_patch with empty input", () => {
    const decision = evaluateSourceChangeGuard({
      toolName: "apply_patch",
      params: { input: "" },
      protectedPrefixes: PROTECTED,
    });
    expect(decision.blocked).toBe(false);
  });

  it("blocks the protected dir root itself", () => {
    const decision = evaluateSourceChangeGuard({
      toolName: "write",
      params: { path: "/Users/ai/openclaw/src/openclaw/src", content: "x" },
      protectedPrefixes: PROTECTED,
    });
    expect(decision.blocked).toBe(true);
  });
});
