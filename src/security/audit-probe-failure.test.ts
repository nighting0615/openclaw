import { describe, expect, it, vi } from "vitest";
import { collectDeepProbeFindings } from "./audit-deep-probe-findings.js";
import { runSecurityAudit } from "./audit.js";

function requireProbeFailure(findings: ReturnType<typeof collectDeepProbeFindings>) {
  const finding = findings.find((entry) => entry.checkId === "gateway.probe_failed");
  if (!finding) {
    throw new Error("Expected gateway probe failure finding");
  }
  return finding;
}

describe("security audit deep probe failure", () => {
  it("uses the presence-only gateway probe for deep audit liveness", async () => {
    const probeGatewayFn = vi.fn(async () => ({
      ok: true,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: 8,
      error: null,
      close: null,
      auth: {
        role: "operator",
        scopes: ["operator.read"],
        capability: "read_only",
      },
      health: null,
      status: null,
      presence: [],
      configSnapshot: null,
    }));

    await runSecurityAudit({
      config: { gateway: { mode: "local" } },
      deep: true,
      includeFilesystem: false,
      includeChannelSecurity: false,
      loadPluginSecurityCollectors: false,
      deepTimeoutMs: 1000,
      probeGatewayFn: probeGatewayFn as never,
    });

    expect(probeGatewayFn).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:18789",
      auth: {},
      timeoutMs: 1000,
      detailLevel: "presence",
    });
  });

  it("adds probe_failed warnings for deep probe failure modes", () => {
    const cases: Array<{
      name: string;
      deep: {
        gateway: {
          attempted: boolean;
          url: string | null;
          ok: boolean;
          error: string | null;
          close?: { code: number; reason: string } | null;
        };
      };
      expectedError: string;
    }> = [
      {
        name: "probe returns failed result",
        deep: {
          gateway: {
            attempted: true,
            ok: false,
            url: "ws://127.0.0.1:18789",
            error: "connect failed",
            close: null,
          },
        },
        expectedError: "connect failed",
      },
      {
        name: "probe throws",
        deep: {
          gateway: {
            attempted: true,
            ok: false,
            url: "ws://127.0.0.1:18789",
            error: "probe boom",
            close: null,
          },
        },
        expectedError: "probe boom",
      },
    ];

    for (const testCase of cases) {
      const findings = collectDeepProbeFindings({ deep: testCase.deep });
      const probeFailure = requireProbeFailure(findings);
      expect(probeFailure.detail, testCase.name).toContain(testCase.expectedError);
    }
  });
});
