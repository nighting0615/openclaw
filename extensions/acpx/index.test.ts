import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import setupPlugin from "./setup-api.js";

const {
  createAcpxRuntimeServiceMock,
  tryDispatchAcpReplyHookMock,
  handleTaskCommandMock,
  handleExcerptCommandMock,
  handleDiaryCommandMock,
  handleHabitCommandMock,
  handleCheckCommandMock,
} = vi.hoisted(() => ({
  createAcpxRuntimeServiceMock: vi.fn(),
  tryDispatchAcpReplyHookMock: vi.fn(),
  handleTaskCommandMock: vi.fn(),
  handleExcerptCommandMock: vi.fn(),
  handleDiaryCommandMock: vi.fn(),
  handleHabitCommandMock: vi.fn(),
  handleCheckCommandMock: vi.fn(),
}));

vi.mock("./register.runtime.js", () => ({
  createAcpxRuntimeService: createAcpxRuntimeServiceMock,
}));

vi.mock("openclaw/plugin-sdk/acp-runtime-backend", () => ({
  tryDispatchAcpReplyHook: tryDispatchAcpReplyHookMock,
}));

vi.mock("./src/task-command.js", () => ({
  handleTaskCommand: handleTaskCommandMock,
}));

vi.mock("./src/check-command.js", () => ({
  handleCheckCommand: handleCheckCommandMock,
}));

vi.mock("./src/excerpt-command.js", () => ({
  handleExcerptCommand: handleExcerptCommandMock,
}));

vi.mock("./src/diary-command.js", () => ({
  handleDiaryCommand: handleDiaryCommandMock,
  handleHabitCommand: handleHabitCommandMock,
}));

import plugin from "./index.js";

type AcpxAutoEnableProbe = Parameters<OpenClawPluginApi["registerAutoEnableProbe"]>[0];

function registerAcpxAutoEnableProbe(): AcpxAutoEnableProbe {
  const probes: AcpxAutoEnableProbe[] = [];
  setupPlugin.register(
    createTestPluginApi({
      registerAutoEnableProbe(probe) {
        probes.push(probe);
      },
    }),
  );
  const probe = probes[0];
  if (!probe) {
    throw new Error("expected ACPX setup plugin to register an auto-enable probe");
  }
  return probe;
}

describe("acpx plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the runtime service, native commands, and reply_dispatch hook", () => {
    const service = { id: "acpx-service", start: vi.fn() };
    createAcpxRuntimeServiceMock.mockReturnValue(service);

    const api = {
      pluginConfig: { stateDir: "/tmp/acpx" },
      registerService: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api as never);

    expect(createAcpxRuntimeServiceMock).toHaveBeenCalledWith({
      pluginConfig: api.pluginConfig,
    });
    expect(api.registerService).toHaveBeenCalledWith(service);
    expect(api.registerCommand).toHaveBeenCalledWith({
      name: "task",
      description: "Manage Obsidian tasks without model routing",
      acceptsArgs: true,
      requireAuth: true,
      handler: handleTaskCommandMock,
    });
    expect(api.registerCommand).toHaveBeenCalledWith({
      name: "raycheck",
      description: "Manage PaperS3 checklists without model routing",
      acceptsArgs: true,
      requireAuth: true,
      handler: handleCheckCommandMock,
    });
    expect(api.registerCommand).toHaveBeenCalledWith({
      name: "excerpt",
      description: "Append a book excerpt without model routing",
      acceptsArgs: true,
      requireAuth: true,
      nativeProgressMessages: { default: "📖 正在录入书摘…" },
      handler: handleExcerptCommandMock,
    });
    expect(api.registerCommand).toHaveBeenCalledWith({
      name: "diary",
      description: "Write Obsidian diary entries without model routing",
      acceptsArgs: true,
      requireAuth: true,
      nativeProgressMessages: { default: "📝 正在写入日记…" },
      handler: handleDiaryCommandMock,
    });
    expect(api.registerCommand).toHaveBeenCalledWith({
      name: "habit",
      description: "Record Obsidian daily habits without model routing",
      acceptsArgs: true,
      requireAuth: true,
      nativeProgressMessages: { default: "✅ 正在记录打卡…" },
      handler: handleHabitCommandMock,
    });
    expect(api.on).toHaveBeenCalledWith("reply_dispatch", tryDispatchAcpReplyHookMock);
  });

  it("preserves the ACP reply_dispatch runtime path through the registered hook", async () => {
    const service = { id: "acpx-service", start: vi.fn() };
    createAcpxRuntimeServiceMock.mockReturnValue(service);
    tryDispatchAcpReplyHookMock.mockResolvedValue({
      handled: true,
      queuedFinal: true,
      counts: { tool: 1, block: 0, final: 1 },
    });

    const on = vi.fn();
    const api = createTestPluginApi({
      pluginConfig: { stateDir: "/tmp/acpx" },
      registerService: vi.fn(),
      on,
    });

    plugin.register(api);

    const hook = on.mock.calls.find(([hookName]) => hookName === "reply_dispatch")?.[1];
    if (!hook) {
      throw new Error("expected reply_dispatch hook to be registered");
    }

    const event = {
      ctx: { raw: "reply ctx" },
      runId: "run-1",
      sessionKey: "agent:test:session",
      inboundAudio: false,
      shouldRouteToOriginating: false,
      shouldSendToolSummaries: true,
      sendPolicy: "allow",
    };
    const ctx = {
      cfg: {},
      dispatcher: { dispatch: vi.fn(), getQueuedCounts: vi.fn(), getFailedCounts: vi.fn() },
      recordProcessed: vi.fn(),
      markIdle: vi.fn(),
    };

    await expect(hook(event, ctx)).resolves.toEqual({
      handled: true,
      queuedFinal: true,
      counts: { tool: 1, block: 0, final: 1 },
    });
    expect(tryDispatchAcpReplyHookMock).toHaveBeenCalledWith(event, ctx);
  });

  it("declares setup auto-enable reasons for ACPX-owned ACP config", () => {
    const probe = registerAcpxAutoEnableProbe();

    expect(probe({ config: { acp: { enabled: true } }, env: {} })).toBe("ACP runtime configured");
    expect(probe({ config: { acp: { backend: "acpx" } }, env: {} })).toBe("ACP runtime configured");
    expect(probe({ config: { acp: { enabled: true, backend: "custom-runtime" } }, env: {} })).toBe(
      null,
    );
  });
});
