import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { doctorShellCompletion } from "./doctor-completion.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const mocks = vi.hoisted(() => ({
  resolveCliName: vi.fn(() => "openclaw"),
  resolveOpenClawPackageRoot: vi.fn(async () => "/repo"),
  resolveShellFromEnv: vi.fn(() => "zsh"),
  isCompletionInstalled: vi.fn(async () => true),
  completionCacheExists: vi.fn(async () => false),
  resolveCompletionCachePath: vi.fn(() => "/home/me/.cache/openclaw/zsh"),
  usesSlowDynamicCompletion: vi.fn(async () => false),
  installCompletion: vi.fn(async () => {}),
  note: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0 })),
}));

vi.mock("node:child_process", () => ({
  spawnSync: mocks.spawnSync,
}));

vi.mock("../cli/cli-name.js", () => ({
  resolveCliName: mocks.resolveCliName,
}));

vi.mock("../cli/completion-runtime.js", () => ({
  resolveShellFromEnv: mocks.resolveShellFromEnv,
  isCompletionInstalled: mocks.isCompletionInstalled,
  completionCacheExists: mocks.completionCacheExists,
  resolveCompletionCachePath: mocks.resolveCompletionCachePath,
  usesSlowDynamicCompletion: mocks.usesSlowDynamicCompletion,
  installCompletion: mocks.installCompletion,
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: mocks.resolveOpenClawPackageRoot,
}));

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

function makePrompter(shouldRepair: boolean): DoctorPrompter {
  return {
    confirm: vi.fn(async () => false),
    confirmAutoFix: vi.fn(async () => false),
    confirmAggressiveAutoFix: vi.fn(async () => false),
    confirmRuntimeRepair: vi.fn(async () => false),
    select: vi.fn(async (_params, fallback) => fallback),
    shouldRepair,
    shouldForce: false,
    repairMode: {
      canPrompt: false,
      nonInteractive: true,
      shouldForce: false,
      shouldRepair,
      updateInProgress: false,
    },
  };
}

describe("doctorShellCompletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCliName.mockReturnValue("openclaw");
    mocks.resolveOpenClawPackageRoot.mockResolvedValue("/repo");
    mocks.resolveShellFromEnv.mockReturnValue("zsh");
    mocks.isCompletionInstalled.mockResolvedValue(true);
    mocks.completionCacheExists.mockResolvedValue(false);
    mocks.resolveCompletionCachePath.mockReturnValue("/home/me/.cache/openclaw/zsh");
    mocks.usesSlowDynamicCompletion.mockResolvedValue(false);
    mocks.spawnSync.mockReturnValue({ status: 0 });
  });

  it("does not regenerate a missing completion cache during non-interactive check mode", async () => {
    await doctorShellCompletion(
      { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      makePrompter(false),
      { nonInteractive: true },
    );

    expect(spawnSync).not.toHaveBeenCalled();
    expect(mocks.installCompletion).not.toHaveBeenCalled();
    expect(mocks.note.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "completion --write-state",
    );
  });

  it("regenerates a missing completion cache during non-interactive repair mode", async () => {
    await doctorShellCompletion(
      { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      makePrompter(true),
      { nonInteractive: true },
    );

    expect(spawnSync).toHaveBeenCalledWith(
      process.execPath,
      ["/repo/openclaw.mjs", "completion", "--write-state"],
      expect.objectContaining({ cwd: "/repo", timeout: 30_000 }),
    );
  });
});
