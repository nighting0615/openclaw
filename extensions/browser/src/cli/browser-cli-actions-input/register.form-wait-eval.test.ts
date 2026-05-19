import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as browserCliSharedModule from "../browser-cli-shared.js";
import {
  createBrowserProgram,
  getBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
} from "../browser-cli.test-support.js";
import * as cliCoreApiModule from "../core-api.js";

const mocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn<
    (
      opts?: unknown,
      req?: unknown,
      extra?: { timeoutMs?: number },
    ) => Promise<Record<string, unknown>>
  >(async () => ({ result: true })),
}));

vi.spyOn(browserCliSharedModule, "callBrowserRequest").mockImplementation(mocks.callBrowserRequest);
const browserCliRuntime = getBrowserCliRuntime();
vi.spyOn(cliCoreApiModule.defaultRuntime, "log").mockImplementation(browserCliRuntime.log);
vi.spyOn(cliCoreApiModule.defaultRuntime, "writeJson").mockImplementation(
  browserCliRuntime.writeJson,
);
vi.spyOn(cliCoreApiModule.defaultRuntime, "error").mockImplementation(browserCliRuntime.error);
vi.spyOn(cliCoreApiModule.defaultRuntime, "exit").mockImplementation(browserCliRuntime.exit);

const { registerBrowserActionInputCommands } = await import("./register.js");

function createActionInputProgram(): Command {
  const { program, browser, parentOpts } = createBrowserProgram();
  registerBrowserActionInputCommands(browser, parentOpts);
  return program;
}

describe("browser action input wait command", () => {
  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
    getBrowserCliRuntime().exit.mockImplementation(() => {});
  });

  it("keeps the outer request open longer than a time-based wait", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(["browser", "wait", "--time", "25000"], { from: "user" });

    const options = mocks.callBrowserRequest.mock.calls.at(-1)?.[2] as
      | { timeoutMs?: number }
      | undefined;
    expect(options?.timeoutMs).toBeGreaterThan(25000);
  });

  it("keeps the outer request open for time delay plus condition timeout", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(["browser", "wait", "--time", "1000", "--text", "Ready"], {
      from: "user",
    });

    const options = mocks.callBrowserRequest.mock.calls.at(-1)?.[2] as
      | { timeoutMs?: number }
      | undefined;
    expect(options?.timeoutMs).toBeGreaterThan(21000);
  });

  it("rejects invalid load state instead of dropping it", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(["browser", "wait", "--text", "Ready", "--load", "bogus"], {
      from: "user",
    });

    const errorCall = getBrowserCliRuntime().error.mock.calls.at(-1);
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
    expect(String(errorCall?.[0])).toContain("Invalid --load");
    expect(getBrowserCliRuntime().exit).toHaveBeenCalledWith(1);
  });

  it("rejects invalid numeric wait options instead of dropping them", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(["browser", "wait", "--text", "Ready", "--time", "nope"], {
      from: "user",
    });

    const errorCall = getBrowserCliRuntime().error.mock.calls.at(-1);
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
    expect(String(errorCall?.[0])).toContain("Invalid --time");
    expect(getBrowserCliRuntime().exit).toHaveBeenCalledWith(1);
  });
});
