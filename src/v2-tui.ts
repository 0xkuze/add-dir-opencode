import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/plugin"
import type { DialogSelectOption } from "@opencode/plugin/tui/context"
import { readdirSync } from "fs"
import { basename, dirname, join } from "path"
import { addDir, allDirs, removeDir, resolvePath, validate } from "./tui-state.js"

/**
 * V2 CLI plugin (OpenCode 2, `@opencode/plugin/tui`).
 *
 * Registers the same three slash commands as the V1 TUI plugin (`/add-dir`,
 * `/list-dir`, `/remove-dir`) using V2 keymap layers and promise-based
 * dialogs. The V2 server plugin handles permissions, so adding a directory
 * needs no grant prompt or session side effects; the directory list reaches
 * the model through the `session.hook("context")` system injection.
 */
export const AddDirTuiV2 = Plugin.define({
  id: "opencode-add-dir",
  async setup(context) {
    // `context.keymap` is backed by a Solid context provider that only exists
    // inside the component tree; calling `keymap.layer` directly in setup
    // throws "Keymap.Provider is missing". Register global commands from a
    // mounted `app` slot instead, as the CLI plugin guide does for global
    // layers. The claim renders nothing; it only owns the keymap layer.
    return context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "opencode-add-dir.add",
              title: "Add directory",
              description: "Add a working directory",
              group: "Directories",
              palette: true,
              slash: { name: "add-dir" },
              run: () => void runAddDir(context),
            },
            {
              id: "opencode-add-dir.list",
              title: "List directories",
              description: "Show working directories",
              group: "Directories",
              palette: true,
              slash: { name: "list-dir" },
              run: () => void runListDirs(context),
            },
            {
              id: "opencode-add-dir.remove",
              title: "Remove directory",
              description: "Remove a working directory",
              group: "Directories",
              palette: true,
              slash: { name: "remove-dir" },
              run: () => void runRemoveDir(context),
            },
          ],
        }))
        return null
      },
    })
  },
})

function toast(context: Context, variant: "info" | "success" | "error", message: string) {
  context.ui.toast.show({ variant, message })
}

/** Non-hidden subdirectories of `dir`, sorted by name. Exported for tests. */
export function listSubdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(dir, entry.name))
      .sort()
  } catch {
    return []
  }
}

const TYPE_PATH_INSTEAD = "__type_path__"

/**
 * Interactive directory browser built from promise-based select dialogs:
 * start at `start`, descend into subdirectories, go up with `..`, confirm the
 * current directory, or fall back to typing a path.
 */
async function browseDirectory(context: Context, start: string): Promise<string | undefined> {
  let current = start
  for (;;) {
    const options: DialogSelectOption<string>[] = [
      { title: `✓ Add this directory — ${current}`, value: current, footer: "Confirm" },
      ...listSubdirs(current).map((dir) => ({
        title: `${basename(dir)}/`,
        value: dir,
        description: dir,
      })),
    ]

    const parent = dirname(current)
    if (parent !== current) options.push({ title: "..", value: parent, description: parent })

    options.push({ title: "Type a path instead…", value: TYPE_PATH_INSTEAD })

    const next = await context.ui.dialog.select<string>({
      title: "Add directory",
      placeholder: "Browse or confirm",
      current,
      options,
    })

    if (next === undefined) return undefined
    if (next === current) return current
    if (next === TYPE_PATH_INSTEAD) {
      const typed = await context.ui.dialog.prompt({
        title: "Add directory",
        placeholder: "/path/to/directory",
        description: "Paste the absolute path of the directory to add.",
      })
      return typed === undefined ? undefined : resolvePath(typed)
    }
    current = next
  }
}

async function runAddDir(context: Context) {
  const start = dirname(context.location?.directory ?? process.cwd())
  const abs = await browseDirectory(context, start)
  if (abs === undefined) return

  const err = validate(abs)
  if (err) return toast(context, "error", err)

  const persist = await context.ui.dialog.select<boolean>({
    title: `Remember ${basename(abs)}?`,
    current: false,
    options: [
      { title: "This session only", value: false, description: "Cleared when OpenCode restarts" },
      { title: "Remember across sessions", value: true, description: "Reloaded on every startup" },
    ],
  })
  if (persist === undefined) return

  addDir(abs, persist)
  // No session message: the server plugin injects the directory list into
  // the system prompt on every model request, which notifies the agent on
  // its next turn without spawning a request or showing a message.
  toast(context, "success", `Added ${abs} (${persist ? "persistent" : "session"})`)
}

async function runListDirs(context: Context) {
  const dirs = allDirs()
  if (!dirs.length) return toast(context, "info", "No directories added.")
  await context.ui.dialog.alert({ title: `Directories (${dirs.length})`, message: dirs.join("\n") })
}

async function runRemoveDir(context: Context) {
  const dirs = allDirs()
  if (!dirs.length) return toast(context, "info", "No directories to remove.")

  const selected = await context.ui.dialog.select({
    title: "Remove directory",
    options: dirs.map((d) => ({ title: d, value: d })),
  })
  if (selected === undefined) return

  const confirmed = await context.ui.dialog.confirm({
    title: "Remove directory",
    message: `Remove ${selected}?`,
  })
  if (!confirmed) return

  removeDir(selected)
  toast(context, "success", `Removed ${selected}`)
}
