import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  evaluateFamilyRawExecPolicy: vi.fn(),
  processGatewayAllowlist: vi.fn(),
}));

vi.mock("./family-capability-policy.js", () => ({
  evaluateFamilyRawExecPolicy: mocks.evaluateFamilyRawExecPolicy,
}));

vi.mock("./bash-tools.exec-host-gateway.js", () => ({
  processGatewayAllowlist: mocks.processGatewayAllowlist,
}));

describe("exec family policy integration", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.evaluateFamilyRawExecPolicy.mockReset();
    mocks.processGatewayAllowlist.mockReset();
  });

  it("blocks raw exec when family policy denies it", async () => {
    mocks.evaluateFamilyRawExecPolicy.mockResolvedValueOnce({
      allowed: false,
      reason:
        "exec denied: this family workspace may use approved product wrappers only; raw exec is blocked.",
    });

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      sessionKey: "agent:ray:main",
    });

    await expect(
      tool.execute("call-raw", {
        command: "python3 - <<'PY'\nprint('hi')\nPY",
        workdir: "/Users/ai/openclaw/workspaces/main/ray",
      }),
    ).rejects.toThrow(/family workspace may use approved product wrappers only/);

    expect(mocks.processGatewayAllowlist).not.toHaveBeenCalled();
  });

  it("continues through the gateway path when family policy allows a wrapper", async () => {
    mocks.evaluateFamilyRawExecPolicy.mockResolvedValueOnce({ allowed: true });
    mocks.processGatewayAllowlist.mockResolvedValueOnce({
      pendingResult: {
        content: [{ type: "text", text: "wrapper allowed" }],
        details: { status: "running" },
      },
    });

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      sessionKey: "agent:ray:main",
    });

    const result = await tool.execute("call-wrapper", {
      command: "bash scripts/seedance.sh generate --prompt hi",
      workdir: "/Users/ai/openclaw/workspaces/main",
    });

    expect(mocks.processGatewayAllowlist).toHaveBeenCalled();
    expect(result.content.find((item) => item.type === "text")?.text).toContain("wrapper allowed");
  });
});
