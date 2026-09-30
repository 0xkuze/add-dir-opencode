import type { Plugin, Config } from "@opencode-ai/plugin"
import { freshDirs, ensureTuiConfig } from "./state.js"
import { permissionGlob, grantSession, shouldGrantBeforeTool, autoApprovePermission } from "./permissions.js"
import { collectAgentContext } from "./context.js"
import type { SDK, PermissionEvent, ToolArgs } from "./types.js"

export const AddDirPlugin: Plugin = async ({ client }) => {
  ensureTuiConfig()
  const sdk: SDK = client

  return {
    config: async (cfg: Config) => {
      const dirs = freshDirs()
      if (!dirs.size) return
      const perm = ((cfg as Record<string, unknown>).permission ??= {}) as Record<string, unknown>
      const extDir = (perm.external_directory ??= {}) as Record<string, string>
      for (const entry of dirs.values())
        extDir[permissionGlob(entry.path)] = "allow"
    },

    "tool.execute.before": async (input, output) => {
      const dirs = freshDirs()
      if (shouldGrantBeforeTool(dirs, input.tool, output.args as ToolArgs))
        await grantSession(sdk, input.sessionID)
    },

    event: async ({ event }) => {
      const e = event as { type: string; properties?: PermissionEvent }
      if (e.type === "permission.asked" && e.properties) {
        const dirs = freshDirs()
        await autoApprovePermission(sdk, e.properties, dirs)
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      const dirs = freshDirs()
      output.system.push(...collectAgentContext(dirs))
    },
  }
}
