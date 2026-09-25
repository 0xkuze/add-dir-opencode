import { Plugin } from "@opencode/plugin"
import { clearSessionDirs, expandHome, freshDirs, matchesDirs } from "./state.js"
import { collectAgentContext } from "./context.js"

/**
 * V2 server plugin (OpenCode 2, `@opencode/plugin`).
 *
 * The V1 plugin needed three cooperating hacks to auto-approve external
 * directories (config permission injection, a `tool.execute.before` grant
 * prompt, and replying to `permission.asked` events). V2 evaluates
 * permissions through one hook: every external-directory check funnels through
 * `ctx.permission.hook("evaluate")`, which runs before a permission prompt is
 * published, so allowing it there covers read/edit/glob/grep/shell uniformly.
 */
export const AddDirServerV2 = Plugin.define({
  id: "opencode-add-dir",
  async setup(ctx) {
    // Session-only directories do not survive an OpenCode restart.
    clearSessionDirs()

    await ctx.permission.hook("evaluate", (event) => {
      if (event.action !== "external_directory") return
      const dirs = freshDirs()
      if (!dirs.size) return

      // Resources are canonical external-directory boundaries, normally
      // ending in `/*`. Strip the wildcard and match against added dirs.
      const allowed = event.resources.some((resource) =>
        matchesDirs(dirs, expandHome(resource.replace(/\/\*$/, ""))),
      )
      if (allowed) event.effect = "allow"
    })

    await ctx.session.hook("context", (event) => {
      for (const text of collectAgentContext(freshDirs()))
        event.system.push({ type: "text", text })
    })
  },
})
