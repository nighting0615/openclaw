import { tryDispatchAcpReplyHook } from "openclaw/plugin-sdk/acp-runtime-backend";
import { createAcpxRuntimeService } from "./register.runtime.js";
import type { OpenClawPluginApi } from "./runtime-api.js";
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
    api.on("reply_dispatch", tryDispatchAcpReplyHook);
  },
};

export default plugin;
