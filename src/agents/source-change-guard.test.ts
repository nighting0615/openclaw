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

  describe("exec command guarding", () => {
    it("blocks exec with output redirection into protected path", () => {
      const decision = evaluateSourceChangeGuard({
        toolName: "exec",
        params: {
          command: "echo hi > /Users/ai/openclaw/src/openclaw/src/foo.ts",
        },
        protectedPrefixes: PROTECTED,
      });
      expect(decision.blocked).toBe(true);
      if (decision.blocked) {
        expect(decision.reason).toMatch(/Detected write to: /);
      }
    });

    it("blocks append redirection (>>)", () => {
      const decision = evaluateSourceChangeGuard({
        toolName: "exec",
        params: {
          command: "printf hello >> /Users/ai/openclaw/src/openclaw/extensions/foo.ts",
        },
        protectedPrefixes: PROTECTED,
      });
      expect(decision.blocked).toBe(true);
    });

    it("blocks tee writing to protected path", () => {
      const decision = evaluateSourceChangeGuard({
        toolName: "exec",
        params: {
          command: "echo x | tee /Users/ai/openclaw/src/openclaw/src/foo.ts",
        },
        protectedPrefixes: PROTECTED,
      });
      expect(decision.blocked).toBe(true);
    });

    it("blocks cp into protected path (last arg semantics)", () => {
      const decision = evaluateSourceChangeGuard({
        toolName: "exec",
        params: {
          command: "cp /tmp/x /Users/ai/openclaw/src/openclaw/src/foo.ts",
        },
        protectedPrefixes: PROTECTED,
      });
      expect(decision.blocked).toBe(true);
    });

    it("blocks mv whose destination is protected", () => {
      const decision = evaluateSourceChangeGuard({
        toolName: "exec",
        params: {
          command: "mv /tmp/x /Users/ai/openclaw/src/openclaw/src/foo.ts",
        },
        protectedPrefixes: PROTECTED,
      });
      expect(decision.blocked).toBe(true);
    });

    it("blocks rm of protected path", () => {
      const decision = evaluateSourceChangeGuard({
        toolName: "exec",
        params: {
          command: "rm -f /Users/ai/openclaw/src/openclaw/src/foo.ts",
        },
        protectedPrefixes: PROTECTED,
      });
      expect(decision.blocked).toBe(true);
    });

    it("blocks sed -i editing protected path", () => {
      const decision = evaluateSourceChangeGuard({
        toolName: "exec",
        params: {
          command: "sed -i '' 's/a/b/' /Users/ai/openclaw/src/openclaw/src/foo.ts",
        },
        protectedPrefixes: PROTECTED,
      });
      expect(decision.blocked).toBe(true);
    });

    it("blocks bash -c '...' wrapping a write into protected path", () => {
      const decision = evaluateSourceChangeGuard({
        toolName: "exec",
        params: {
          command: "bash -c 'echo hi > /Users/ai/openclaw/src/openclaw/src/foo.ts'",
        },
        protectedPrefixes: PROTECTED,
      });
      expect(decision.blocked).toBe(true);
    });

    it("normalizes bash → exec via tool alias and blocks", () => {
      const decision = evaluateSourceChangeGuard({
        toolName: "bash",
        params: {
          command: "echo hi > /Users/ai/openclaw/src/openclaw/src/foo.ts",
        },
        protectedPrefixes: PROTECTED,
      });
      expect(decision.blocked).toBe(true);
    });

    it("resolves relative redirect targets against workdir", () => {
      const decision = evaluateSourceChangeGuard({
        toolName: "exec",
        params: {
          command: "echo hi > foo.ts",
          workdir: "/Users/ai/openclaw/src/openclaw/src/agents",
        },
        protectedPrefixes: PROTECTED,
      });
      expect(decision.blocked).toBe(true);
    });

    it("allows exec reading from protected path (cat)", () => {
      const decision = evaluateSourceChangeGuard({
        toolName: "exec",
        params: {
          command: "cat /Users/ai/openclaw/src/openclaw/src/agents/foo.ts",
        },
        protectedPrefixes: PROTECTED,
      });
      expect(decision.blocked).toBe(false);
    });

    it("allows exec listing/grepping protected path", () => {
      const decisions = [
        "ls /Users/ai/openclaw/src/openclaw/src/agents",
        "grep -r 'needle' /Users/ai/openclaw/src/openclaw/src/",
        "git -C /Users/ai/openclaw/src/openclaw status",
        "rg --files /Users/ai/openclaw/src/openclaw/src/",
      ].map((command) =>
        evaluateSourceChangeGuard({
          toolName: "exec",
          params: { command },
          protectedPrefixes: PROTECTED,
        }),
      );
      for (const decision of decisions) {
        expect(decision.blocked).toBe(false);
      }
    });

    it("does not treat > inside single quotes as a redirect", () => {
      const decision = evaluateSourceChangeGuard({
        toolName: "exec",
        params: {
          command:
            "grep -E '>|gt' /Users/ai/openclaw/src/openclaw/src/agents/source-change-guard.ts",
        },
        protectedPrefixes: PROTECTED,
      });
      expect(decision.blocked).toBe(false);
    });

    it("allows redirect into a non-protected file", () => {
      const decision = evaluateSourceChangeGuard({
        toolName: "exec",
        params: {
          command: "echo hi > /tmp/x.txt",
        },
        protectedPrefixes: PROTECTED,
      });
      expect(decision.blocked).toBe(false);
    });

    it("allows cp whose destination is a workspace path even if source touches protected", () => {
      const decision = evaluateSourceChangeGuard({
        toolName: "exec",
        params: {
          command:
            "cp /Users/ai/openclaw/src/openclaw/src/foo.ts /Users/ai/openclaw/workspaces/main/copy.ts",
        },
        protectedPrefixes: PROTECTED,
      });
      expect(decision.blocked).toBe(false);
    });
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
