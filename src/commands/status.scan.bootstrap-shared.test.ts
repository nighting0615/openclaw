import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { UpdateCheckResult } from "../infra/update-check.js";
import { createStatusScanCoreBootstrap } from "./status.scan.bootstrap-shared.js";

const mocks = vi.hoisted(() => ({
  resolveGatewayProbeSnapshot: vi.fn(async () => ({
    gatewayConnection: null,
    remoteUrlMissing: false,
    gatewayMode: "local",
    gatewayProbeAuth: {},
    gatewayProbeAuthWarning: undefined,
    gatewayProbe: null,
    gatewayReachable: false,
    gatewaySelf: null,
  })),
  buildTailscaleHttpsUrl: vi.fn(() => null),
}));

vi.mock("./status.scan.shared.js", () => ({
  resolveGatewayProbeSnapshot: mocks.resolveGatewayProbeSnapshot,
  buildTailscaleHttpsUrl: mocks.buildTailscaleHttpsUrl,
}));

describe("createStatusScanCoreBootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function collectUpdateParams(opts: { timeoutMs?: number; all?: boolean; deep?: boolean }) {
    const getUpdateCheckResult = vi.fn(
      async () =>
        ({
          root: "/repo",
          installKind: "git",
          packageManager: "pnpm",
        }) satisfies UpdateCheckResult,
    );

    const bootstrap = await createStatusScanCoreBootstrap({
      coldStart: false,
      cfg: { session: {} } as OpenClawConfig,
      hasConfiguredChannels: true,
      opts,
      getTailnetHostname: vi.fn(async () => null),
      getUpdateCheckResult,
      getAgentLocalStatuses: vi.fn(async () => ({
        defaultId: "main",
        agents: [],
        totalSessions: 0,
        bootstrapPendingCount: 0,
      })),
    });
    await bootstrap.updatePromise;
    return getUpdateCheckResult.mock.calls.at(0)?.[0];
  }

  it("uses a longer update check budget for deep status", async () => {
    await expect(collectUpdateParams({ deep: true })).resolves.toEqual(
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
  });

  it("uses a shorter update check budget for fast status", async () => {
    await expect(collectUpdateParams({})).resolves.toEqual(
      expect.objectContaining({ timeoutMs: 5_000 }),
    );
  });

  it("honors an explicit status timeout for update checks", async () => {
    await expect(collectUpdateParams({ deep: true, timeoutMs: 1234 })).resolves.toEqual(
      expect.objectContaining({ timeoutMs: 1234 }),
    );
  });
});
