import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILD_ALL_PROFILES,
  BUILD_ALL_STEPS,
  readLatestFileMtime,
  readLatestGatewayReadyTimestamp,
  resolveGatewayAutoRestartPlan,
  resolveBuildAllStepCacheState,
  resolveBuildAllStep,
  resolveBuildAllSteps,
  restoreBuildAllStepCacheOutputs,
  waitForGatewayAutoRestartSync,
  writeBuildAllStepCacheStamp,
} from "../../scripts/build-all.mjs";

function getBuildAllStep(label: string) {
  const step = BUILD_ALL_STEPS.find((entry) => entry.label === label);
  if (!step) {
    throw new Error(`Missing build-all step ${label}`);
  }
  return step;
}

function withBuildCacheFixture(
  run: (fixture: {
    rootDir: string;
    inputPath: string;
    outputPath: string;
    step: {
      label: string;
      cache: {
        inputs: string[];
        outputs: string[];
      };
    };
  }) => void,
) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-build-cache-"));
  try {
    const inputPath = path.join(rootDir, "src/input.ts");
    const outputPath = path.join(rootDir, "dist/output.js");
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(inputPath, "input");
    fs.writeFileSync(outputPath, "output");
    run({
      rootDir,
      inputPath,
      outputPath,
      step: {
        label: "cached",
        cache: {
          inputs: ["src"],
          outputs: ["dist"],
        },
      },
    });
  } finally {
    fs.rmSync(rootDir, { force: true, recursive: true });
  }
}

describe("resolveBuildAllStep", () => {
  it("routes pnpm steps through the npm_execpath pnpm runner on Windows", () => {
    const step = getBuildAllStep("plugins:assets:build");

    const result = resolveBuildAllStep(step, {
      platform: "win32",
      nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
      npmExecPath: "C:/Users/test/AppData/Local/pnpm/10.32.1/bin/pnpm.cjs",
      env: {},
    });

    expect(result).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:/Users/test/AppData/Local/pnpm/10.32.1/bin/pnpm.cjs", "plugins:assets:build"],
      options: {
        stdio: "inherit",
        env: {},
        shell: false,
        windowsVerbatimArguments: undefined,
      },
    });
  });

  it("keeps node steps on the current node binary", () => {
    const step = getBuildAllStep("runtime-postbuild");

    const result = resolveBuildAllStep(step, {
      nodeExecPath: "/custom/node",
      env: { FOO: "bar" },
    });

    expect(result).toEqual({
      command: "/custom/node",
      args: ["scripts/runtime-postbuild.mjs"],
      options: {
        stdio: "inherit",
        env: { FOO: "bar" },
      },
    });
  });

  it("adds heap headroom for plugin-sdk dts on Windows", () => {
    const step = getBuildAllStep("build:plugin-sdk:dts");

    const result = resolveBuildAllStep(step, {
      platform: "win32",
      nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
      npmExecPath: "C:/Users/test/AppData/Local/pnpm/10.32.1/bin/pnpm.cjs",
      env: { FOO: "bar" },
    });

    expect(result).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:/Users/test/AppData/Local/pnpm/10.32.1/bin/pnpm.cjs", "build:plugin-sdk:dts"],
      options: {
        stdio: "inherit",
        env: {
          FOO: "bar",
          NODE_OPTIONS: "--max-old-space-size=4096",
        },
        shell: false,
        windowsVerbatimArguments: undefined,
      },
    });
  });

  it("keeps plugin-sdk dts cache metadata aligned with declaration inputs", () => {
    const step = getBuildAllStep("build:plugin-sdk:dts");

    expect(step.cache?.inputs).toEqual(expect.arrayContaining(["packages/memory-host-sdk/src"]));
    expect(step.cache?.outputs).toEqual(expect.arrayContaining(["dist/plugin-sdk/packages"]));
  });
});

describe("resolveBuildAllSteps", () => {
  it("keeps the full profile aligned with the declared steps", () => {
    expect(resolveBuildAllSteps("full")).toEqual(BUILD_ALL_STEPS);
    expect(BUILD_ALL_PROFILES.full).toEqual(BUILD_ALL_STEPS.map((step) => step.label));
  });

  it("uses a runtime artifact plus plugin SDK export profile for ci artifacts", () => {
    expect(resolveBuildAllSteps("ciArtifacts").map((step) => step.label)).toEqual([
      "plugins:assets:build",
      "tsdown",
      "check-cli-bootstrap-imports",
      "runtime-postbuild",
      "build-stamp",
      "runtime-postbuild-stamp",
      "build:plugin-sdk:dts",
      "write-plugin-sdk-entry-dts",
      "check-plugin-sdk-exports",
      "plugins:assets:copy",
      "copy-hook-metadata",
      "copy-export-html-templates",
      "write-build-info",
      "write-cli-startup-metadata",
      "write-cli-compat",
    ]);
  });

  it("uses a minimal built runtime profile for gateway watch regression", () => {
    expect(resolveBuildAllSteps("gatewayWatch").map((step) => step.label)).toEqual([
      "tsdown",
      "check-cli-bootstrap-imports",
      "runtime-postbuild",
      "build-stamp",
      "runtime-postbuild-stamp",
    ]);
  });

  it("uses a CLI startup profile without generated plugin assets", () => {
    expect(resolveBuildAllSteps("cliStartup").map((step) => step.label)).toEqual([
      "tsdown",
      "check-cli-bootstrap-imports",
      "runtime-postbuild",
      "build-stamp",
      "runtime-postbuild-stamp",
      "write-cli-startup-metadata",
      "write-cli-compat",
    ]);
  });

  it("writes the runtime postbuild stamp after the build stamp", () => {
    const labels = resolveBuildAllSteps("full").map((step) => step.label);
    expect(labels).toContain("runtime-postbuild");
    expect(labels).toContain("build-stamp");
    expect(labels).toContain("runtime-postbuild-stamp");
    expect(labels.indexOf("runtime-postbuild-stamp")).toBeGreaterThan(
      labels.indexOf("build-stamp"),
    );
  });

  it("does not cache plugin-sdk entry shims over compiled JS", () => {
    const step = getBuildAllStep("write-plugin-sdk-entry-dts");
    expect(step.cache).toBeUndefined();
  });

  it("does not cache hook metadata over compiled hook handlers", () => {
    const step = getBuildAllStep("copy-hook-metadata");
    expect(step.cache).toBeUndefined();
  });

  it("rejects unknown build profiles", () => {
    expect(() => resolveBuildAllSteps("wat")).toThrow("Unknown build profile: wat");
  });

  it("enables gateway auto-restart for local full builds on macOS", () => {
    expect(
      resolveGatewayAutoRestartPlan({
        profile: "full",
        platform: "darwin",
        env: {},
        gatewayLabel: "gui/502/ai.openclaw.gateway",
      }),
    ).toEqual({
      enabled: true,
      launchctlCommand: "launchctl",
      gatewayLabel: "gui/502/ai.openclaw.gateway",
      args: ["kickstart", "-k", "gui/502/ai.openclaw.gateway"],
      gatewayLogPath: "/Users/ai/openclaw/runtime/logs/openclaw/gateway.log",
      waitTimeoutMs: 90000,
      waitPollMs: 1000,
    });
  });

  it("skips gateway auto-restart outside the local full-build path", () => {
    expect(
      resolveGatewayAutoRestartPlan({ profile: "gatewayWatch", platform: "darwin", env: {} }),
    ).toEqual({
      enabled: false,
      reason: "non-full-profile",
    });
    expect(resolveGatewayAutoRestartPlan({ profile: "full", platform: "linux", env: {} })).toEqual({
      enabled: false,
      reason: "non-darwin",
    });
    expect(
      resolveGatewayAutoRestartPlan({
        profile: "full",
        platform: "darwin",
        env: { OPENCLAW_BUILD_AUTORESTART_GATEWAY: "0" },
      }),
    ).toEqual({
      enabled: false,
      reason: "disabled",
    });
  });
});

describe("resolveBuildAllStepCacheState", () => {
  it("marks cacheable steps fresh when the input signature matches", () => {
    withBuildCacheFixture(({ rootDir, step }) => {
      const cacheState = resolveBuildAllStepCacheState(step, { rootDir });
      writeBuildAllStepCacheStamp(step, cacheState, { rootDir });

      const fresh = resolveBuildAllStepCacheState(step, { rootDir });
      expect(fresh.cacheable).toBe(true);
      expect(fresh.fresh).toBe(true);
      expect(fresh.reason).toBe("fresh");
      expect(fresh.inputFiles).toBe(1);
      expect(fresh.outputFiles).toBe(1);
      expect(fresh.restorable).toBe(false);
      expect(fresh.relativeOutputFiles).toEqual(["dist/output.js"]);
      expect(fresh.stampedOutputs).toEqual(["dist/output.js"]);
      expect(typeof fresh.signature).toBe("string");
      expect(fresh.signature).toHaveLength(64);
      expect(fresh.outputRoot).toBe(
        path.join(rootDir, ".artifacts/build-all-cache/cached/outputs"),
      );
      expect(fresh.stampPath).toBe(
        path.join(rootDir, ".artifacts/build-all-cache/cached/stamp.json"),
      );
      expect(fresh).toEqual({
        cacheable: true,
        fresh: true,
        inputFiles: 1,
        outputFiles: 1,
        outputRoot: fresh.outputRoot,
        reason: "fresh",
        relativeOutputFiles: ["dist/output.js"],
        restorable: false,
        signature: fresh.signature,
        stampedOutputs: ["dist/output.js"],
        stampPath: fresh.stampPath,
      });
    });
  });

  it("marks cacheable steps stale when an input changes", () => {
    withBuildCacheFixture(({ rootDir, inputPath, step }) => {
      const cacheState = resolveBuildAllStepCacheState(step, { rootDir });
      writeBuildAllStepCacheStamp(step, cacheState, { rootDir });
      fs.writeFileSync(inputPath, "changed");

      const stale = resolveBuildAllStepCacheState(step, { rootDir });
      expect(stale.cacheable).toBe(true);
      expect(stale.fresh).toBe(false);
      expect(stale.reason).toBe("stale");
      expect(stale.inputFiles).toBe(1);
      expect(stale.outputFiles).toBe(1);
      expect(stale.restorable).toBe(false);
      expect(stale.relativeOutputFiles).toEqual(["dist/output.js"]);
      expect(stale.stampedOutputs).toEqual(["dist/output.js"]);
      expect(typeof stale.signature).toBe("string");
      expect(stale.signature).toHaveLength(64);
      expect(stale.outputRoot).toBe(
        path.join(rootDir, ".artifacts/build-all-cache/cached/outputs"),
      );
      expect(stale.stampPath).toBe(
        path.join(rootDir, ".artifacts/build-all-cache/cached/stamp.json"),
      );
      expect(stale).toEqual({
        cacheable: true,
        fresh: false,
        inputFiles: 1,
        outputFiles: 1,
        outputRoot: stale.outputRoot,
        reason: "stale",
        relativeOutputFiles: ["dist/output.js"],
        restorable: false,
        signature: stale.signature,
        stampedOutputs: ["dist/output.js"],
        stampPath: stale.stampPath,
      });
    });
  });

  it("restores cached outputs when generated files were removed", () => {
    withBuildCacheFixture(({ rootDir, outputPath, step }) => {
      const cacheState = resolveBuildAllStepCacheState(step, { rootDir });
      writeBuildAllStepCacheStamp(step, cacheState, { rootDir });
      fs.rmSync(path.join(rootDir, "dist"), { force: true, recursive: true });

      const restorable = resolveBuildAllStepCacheState(step, { rootDir });
      expect(restorable.cacheable).toBe(true);
      expect(restorable.fresh).toBe(true);
      expect(restorable.reason).toBe("fresh-cache");
      expect(restorable.inputFiles).toBe(1);
      expect(restorable.outputFiles).toBe(0);
      expect(restorable.restorable).toBe(true);
      expect(restorable.relativeOutputFiles).toEqual([]);
      expect(restorable.stampedOutputs).toEqual(["dist/output.js"]);
      expect(typeof restorable.signature).toBe("string");
      expect(restorable.signature).toHaveLength(64);
      expect(restorable.outputRoot).toBe(
        path.join(rootDir, ".artifacts/build-all-cache/cached/outputs"),
      );
      expect(restorable.stampPath).toBe(
        path.join(rootDir, ".artifacts/build-all-cache/cached/stamp.json"),
      );
      expect(restorable).toEqual({
        cacheable: true,
        fresh: true,
        inputFiles: 1,
        outputFiles: 0,
        outputRoot: restorable.outputRoot,
        reason: "fresh-cache",
        relativeOutputFiles: [],
        restorable: true,
        signature: restorable.signature,
        stampedOutputs: ["dist/output.js"],
        stampPath: restorable.stampPath,
      });
      expect(restoreBuildAllStepCacheOutputs(restorable, { rootDir })).toBe(true);
      expect(fs.readFileSync(outputPath, "utf8")).toBe("output");
    });
  });
});

describe("gateway auto-restart verification", () => {
  it("reads the latest gateway ready timestamp from the log", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-build-all-ready-log-"));
    try {
      const gatewayLogPath = path.join(rootDir, "gateway.log");
      fs.writeFileSync(
        gatewayLogPath,
        [
          "2026-04-24T16:45:03.642+08:00 [gateway] received SIGTERM; shutting down",
          "2026-04-24T16:45:23.884+08:00 [gateway] ready (8 plugins: telegram; 12.2s)",
          "2026-04-24T16:47:19.121+08:00 [telegram] sendMessage ok chat=109950863 message=8910",
          "2026-04-24T16:48:01.002+08:00 [gateway] ready (8 plugins: telegram; 11.0s)",
          "2026-04-24T16:49:02.003+08:00 [gateway] ready",
        ].join("\n"),
      );

      expect(readLatestGatewayReadyTimestamp(gatewayLogPath)).toBe(
        Date.parse("2026-04-24T16:49:02.003+08:00"),
      );
    } finally {
      fs.rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it("reads the latest file mtime from dist roots", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-build-all-dist-mtime-"));
    try {
      const firstPath = path.join(rootDir, "dist/first.js");
      const secondPath = path.join(rootDir, "dist/nested/second.js");
      fs.mkdirSync(path.dirname(firstPath), { recursive: true });
      fs.mkdirSync(path.dirname(secondPath), { recursive: true });
      fs.writeFileSync(firstPath, "first");
      fs.writeFileSync(secondPath, "second");
      fs.utimesSync(firstPath, new Date("2026-04-24T08:00:00Z"), new Date("2026-04-24T08:00:00Z"));
      fs.utimesSync(secondPath, new Date("2026-04-24T08:01:00Z"), new Date("2026-04-24T08:01:00Z"));

      expect(readLatestFileMtime(path.join(rootDir, "dist"))).toBe(fs.statSync(secondPath).mtimeMs);
    } finally {
      fs.rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it("waits until gateway ready catches up with the latest dist output", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-build-all-sync-"));
    try {
      const distPath = path.join(rootDir, "dist/index.js");
      const gatewayLogPath = path.join(rootDir, "gateway.log");
      fs.mkdirSync(path.dirname(distPath), { recursive: true });
      fs.writeFileSync(distPath, "dist");
      fs.utimesSync(distPath, new Date("2026-04-24T08:00:10Z"), new Date("2026-04-24T08:00:10Z"));
      fs.writeFileSync(
        gatewayLogPath,
        "2026-04-24T16:00:09.000+08:00 [gateway] ready (8 plugins: telegram; 11.0s)\n",
      );

      const ticks = [0, 500, 1_000, 1_500];
      let tickIndex = 0;
      const result = waitForGatewayAutoRestartSync(
        {
          gatewayLogPath,
          waitTimeoutMs: 2_000,
          waitPollMs: 1,
        },
        {
          rootDir,
          startAt: Date.parse("2026-04-24T08:00:00Z"),
          now() {
            const current =
              Date.parse("2026-04-24T08:00:00Z") + ticks[Math.min(tickIndex, ticks.length - 1)];
            tickIndex += 1;
            if (tickIndex === 2) {
              fs.writeFileSync(
                gatewayLogPath,
                "2026-04-24T16:00:11.000+08:00 [gateway] ready (8 plugins: telegram; 11.0s)\n",
              );
            }
            return current;
          },
          log() {},
          pollMs: 1,
        },
      );

      expect(result).toMatchObject({
        ok: true,
        readyAt: Date.parse("2026-04-24T16:00:11.000+08:00"),
      });
    } finally {
      fs.rmSync(rootDir, { force: true, recursive: true });
    }
  });
});
