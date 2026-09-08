import { tryDispatchAcpReplyHook } from "openclaw/plugin-sdk/acp-runtime-backend";
import { createAcpxRuntimeService } from "./register.runtime.js";
import type { OpenClawPluginApi } from "./runtime-api.js";
import { handleCheckCommand } from "./src/check-command.js";
import { handleDiaryCommand, handleHabitCommand } from "./src/diary-command.js";
import { handleExcerptCommand } from "./src/excerpt-command.js";
import { handleTaskCommand } from "./src/task-command.js";

const plugin = {
  id: "acpx",
  name: "ACPX Runtime",
  description: "Embedded ACP runtime backend with plugin-owned session and transport management.",
  register(api: OpenClawPluginApi) {
    api.registerService(
      createAcpxRuntimeService({
        pluginConfig: api.pluginConfig,
      }),
    );
    api.registerCommand({
      name: "task",
      description: "Manage Obsidian tasks without model routing",
      acceptsArgs: true,
      requireAuth: true,
      handler: handleTaskCommand,
    });
    api.registerCommand({
      name: "raycheck",
      description: "Manage PaperS3 checklists without model routing",
      acceptsArgs: true,
      requireAuth: true,
      handler: handleCheckCommand,
    });
    api.registerCommand({
      name: "excerpt",
      description: "Append a book excerpt without model routing",
      acceptsArgs: true,
      requireAuth: true,
      nativeProgressMessages: { default: "📖 正在录入书摘…" },
      handler: handleExcerptCommand,
    });
    api.registerCommand({
      name: "diary",
      description: "Write Obsidian diary entries without model routing",
      acceptsArgs: true,
      requireAuth: true,
      nativeProgressMessages: { default: "📝 正在写入日记…" },
      handler: handleDiaryCommand,
    });
    api.registerCommand({
      name: "habit",
      description: "Record Obsidian daily habits without model routing",
      acceptsArgs: true,
      requireAuth: true,
      nativeProgressMessages: { default: "✅ 正在记录打卡…" },
      handler: handleHabitCommand,
    });
    api.on("reply_dispatch", tryDispatchAcpReplyHook);
  },
};

export default plugin;
