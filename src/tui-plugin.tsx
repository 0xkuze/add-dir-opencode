import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { useKeyboard } from "@opentui/solid"
import { createSignal } from "solid-js"
import { AddDirTuiV2 } from "./v2-tui.js"
import {
  allDirs,
  resolvePath,
  validate,
  addDir,
  removeDir,
} from "./tui-state.js"

function getSessionID(api: TuiPluginApi): string | undefined {
  const r = api.route.current
  return r.name === "session" && r.params ? r.params.sessionID as string : undefined
}

async function ensureSession(api: TuiPluginApi): Promise<string | undefined> {
  const id = getSessionID(api)
  if (id) return id
  const res = await api.client.session.create({})
  if (res.error) return
  api.route.navigate("session", { sessionID: res.data.id })
  return res.data.id
}

function AddDirDialog(props: { api: TuiPluginApi }) {
  const [busy, setBusy] = createSignal(false)
  const [remember, setRemember] = createSignal(false)
  const { api } = props

  useKeyboard((e) => {
    if (e.name !== "tab" || busy()) return
    e.preventDefault()
    e.stopPropagation()
    setRemember((v) => !v)
  })

  return (
    <api.ui.DialogPrompt
      title="Add directory"
      placeholder="/path/to/directory"
      busy={busy()}
      busyText="Adding..."
      description={() => (
        <box gap={1}>
          <box gap={0}>
            <text fg={api.theme.current.textMuted}>How to get the full path:</text>
            <text fg={api.theme.current.textMuted}> 1. cd to the project in your terminal</text>
            <text fg={api.theme.current.textMuted}> 2. Run "pwd", copy the output</text>
            <text fg={api.theme.current.textMuted}> 3. Paste below</text>
          </box>
          <box flexDirection="row" gap={1}>
            <text fg={remember() ? api.theme.current.text : api.theme.current.textMuted}>
              {remember() ? "[x]" : "[ ]"} Remember across sessions
            </text>
            <text fg={api.theme.current.textMuted}>(tab)</text>
          </box>
        </box>
      )}
      onConfirm={async (value) => {
        if (busy()) return
        const err = validate(value)
        if (err) return api.ui.toast({ variant: "error", message: err })

        const abs = resolvePath(value)
        const persist = remember()

        setBusy(true)
        const sid = await ensureSession(api)
        if (!sid) {
          setBusy(false)
          return api.ui.toast({ variant: "error", message: "Failed to create session" })
        }

        addDir(abs, persist)
        api.ui.dialog.clear()

        const label = persist ? "persistent" : "session"
        api.client.session.prompt({
          sessionID: sid,
          parts: [{ type: "text", text: `Added ${abs} as a working directory (${label}).`, ignored: true }],
          noReply: true,
          tools: { external_directory: true },
        }).catch(() => {})
      }}
      onCancel={() => api.ui.dialog.clear()}
    />
  )
}

function showListDirs(api: TuiPluginApi) {
  const dirs = allDirs()
  if (!dirs.length) return api.ui.toast({ variant: "info", message: "No directories added." })
  api.ui.dialog.replace(() => (
    <api.ui.DialogAlert
      title={`Directories (${dirs.length})`}
      message={dirs.join("\n")}
      onConfirm={() => api.ui.dialog.clear()}
    />
  ))
}

function showRemoveDir(api: TuiPluginApi) {
  const dirs = allDirs()
  if (!dirs.length) return api.ui.toast({ variant: "info", message: "No directories to remove." })
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="Remove directory"
      options={dirs.map((d) => ({ title: d, value: d }))}
      onSelect={(opt) => {
        api.ui.dialog.replace(() => (
          <api.ui.DialogConfirm
            title="Remove directory"
            message={`Remove ${opt.value}?`}
            onConfirm={() => {
              removeDir(opt.value as string)
              api.ui.dialog.clear()
              api.ui.toast({ variant: "success", message: `Removed ${opt.value}` })
            }}
            onCancel={() => showRemoveDir(api)}
          />
        ))
      }}
    />
  ))
}

const tui: TuiPlugin = async (api) => {
  api.command?.register(() => [
    { title: "Add directory", value: "add-dir", description: "Add a working directory", category: "Directories", slash: { name: "add-dir" }, onSelect: () => api.ui.dialog.replace(() => <AddDirDialog api={api} />) },
    { title: "List directories", value: "list-dir", description: "Show working directories", category: "Directories", slash: { name: "list-dir" }, onSelect: () => showListDirs(api) },
    { title: "Remove directory", value: "remove-dir", description: "Remove a working directory", category: "Directories", slash: { name: "remove-dir" }, onSelect: () => showRemoveDir(api) },
  ])
}

/**
 * Dual V1/V2 TUI entrypoint.
 *
 * - OpenCode 2 reads `id` + `setup()` and ignores `tui`.
 * - OpenCode 1 calls `tui()` and ignores `setup`.
 */
export default {
  ...AddDirTuiV2,
  tui,
} satisfies TuiPluginModule & { id: string }
