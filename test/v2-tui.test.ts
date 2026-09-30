import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import type { Context, KeymapCommand } from "@opencode/plugin/tui/context"
import { AddDirTuiV2, listSubdirs } from "../src/v2-tui"
import { allDirs } from "../src/tui-state"
import { invalidateCache, persistedFile, sessionFile } from "../src/state"
import { createTestEnvironment } from "./environment"

let environment: ReturnType<typeof createTestEnvironment>
let TMP: string
let PROJECT: string
let EXTERNAL: string

beforeEach(() => {
  environment = createTestEnvironment("add-dir-tui-test-")
  TMP = environment.root
  PROJECT = join(TMP, "project")
  EXTERNAL = join(TMP, "external")
  mkdirSync(PROJECT)
  mkdirSync(EXTERNAL)
})
afterEach(() => { environment.cleanup(); invalidateCache() })

async function commands(options: {
  selections?: unknown[]
  typed?: string
  confirmed?: boolean
  location?: string
} = {}) {
  const selections = [...(options.selections ?? [])]
  let registered: readonly KeymapCommand[] = []
  const toasts: { variant: string; message: string }[] = []
  const alerts: { title: string; message: string }[] = []
  const context = {
    location: { directory: options.location ?? PROJECT },
    keymap: { layer: (input: () => { commands: readonly KeymapCommand[] }) => { registered = input().commands } },
    ui: {
      slot: (claim: { render: () => unknown }) => { claim.render(); return () => {} },
      toast: { show: (input: { variant: string; message: string }) => { toasts.push(input) } },
      dialog: {
        select: async () => selections.shift(),
        prompt: async () => options.typed,
        confirm: async () => options.confirmed ?? false,
        alert: async (input: { title: string; message: string }) => { alerts.push(input) },
      },
    },
  } as unknown as Context
  await AddDirTuiV2.setup(context)
  return {
    toasts,
    alerts,
    async run(name: string) {
      const command = registered.find((entry) => entry.slash?.name === name)
      if (!command) throw new Error(`Missing command: ${name}`)
      await command.run()
    },
  }
}

describe("listSubdirs", () => {
  test("lists non-hidden subdirectories sorted by name", async () => {
    mkdirSync(join(TMP, "b-dir"))
    mkdirSync(join(TMP, "a-dir"))
    writeFileSync(join(TMP, "file.txt"), "not a dir")
    expect(await listSubdirs(TMP)).toEqual([
      join(TMP, "a-dir"), join(TMP, "b-dir"), EXTERNAL, PROJECT,
    ])
  })

  test("skips hidden directories", async () => {
    mkdirSync(join(TMP, ".git"))
    mkdirSync(join(TMP, "visible"))
    expect(await listSubdirs(TMP)).toEqual([EXTERNAL, PROJECT, join(TMP, "visible")])
  })

  test("returns empty for a missing directory", async () => {
    expect(await listSubdirs(join(TMP, "missing"))).toEqual([])
  })
})

describe("V2 directory commands", () => {
  test.each(["", "   "])("rejects an empty typed path %j", async (typed) => {
    const ui = await commands({ selections: ["__type_path__", false], typed })
    await ui.run("add-dir")
    expect(ui.toasts).toEqual([{ variant: "error", message: "Path is required." }])
    expect(allDirs()).toEqual([])
  })

  test.each([false, true])("adds a typed directory with persistence=%s", async (persist) => {
    const ui = await commands({ selections: ["__type_path__", persist], typed: ` ${EXTERNAL} ` })
    await ui.run("add-dir")
    const file = persist ? persistedFile() : sessionFile()
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual([EXTERNAL])
    expect(ui.toasts[0]?.variant).toBe("success")
  })

  test("browses into a child directory and confirms it", async () => {
    const ui = await commands({ selections: [EXTERNAL, EXTERNAL, false] })
    await ui.run("add-dir")
    expect(allDirs()).toEqual([EXTERNAL])
  })

  test.each([[undefined], ["__type_path__"], [EXTERNAL, EXTERNAL, undefined]])(
    "cancels without writing state: %j", async (...selections) => {
      const ui = await commands({ selections })
      await ui.run("add-dir")
      expect(allDirs()).toEqual([])
      expect(ui.toasts).toEqual([])
    },
  )

  test("lists and removes a remembered directory", async () => {
    const add = await commands({ selections: [EXTERNAL, EXTERNAL, true] })
    await add.run("add-dir")
    const ui = await commands({ selections: [EXTERNAL], confirmed: true })
    await ui.run("list-dir")
    expect(ui.alerts).toEqual([{ title: "Directories (1)", message: EXTERNAL }])
    await ui.run("remove-dir")
    expect(allDirs()).toEqual([])
    expect(ui.toasts[0]?.variant).toBe("success")
  })

  test("keeps a directory when removal is cancelled", async () => {
    const add = await commands({ selections: [EXTERNAL, EXTERNAL, false] })
    await add.run("add-dir")
    const ui = await commands({ selections: [EXTERNAL], confirmed: false })
    await ui.run("remove-dir")
    expect(allDirs()).toEqual([EXTERNAL])
  })

  test("reports filesystem write failures without an unhandled rejection", async () => {
    mkdirSync(persistedFile(), { recursive: true })
    const ui = await commands({ selections: [EXTERNAL, EXTERNAL, true] })
    await ui.run("add-dir")
    expect(ui.toasts).toHaveLength(1)
    expect(ui.toasts[0]?.variant).toBe("error")
    expect(allDirs()).toEqual([])
  })

  test("reports directory browsing failures", async () => {
    const file = join(TMP, "file")
    writeFileSync(file, "not a directory")
    const ui = await commands({ location: join(file, "project") })
    await ui.run("add-dir")
    expect(ui.toasts[0]?.variant).toBe("error")
  })

  test("ignores malformed state and keeps persistence paths dynamic", async () => {
    mkdirSync(join(process.env["XDG_DATA_HOME"]!, "opencode", "add-dir"), { recursive: true })
    writeFileSync(persistedFile(), JSON.stringify({ unexpected: true }))
    expect(allDirs()).toEqual([])
    process.env["XDG_DATA_HOME"] = join(TMP, "other-data")
    const ui = await commands({ selections: [EXTERNAL, EXTERNAL, true] })
    await ui.run("add-dir")
    expect(existsSync(persistedFile())).toBe(true)
    expect(allDirs()).toEqual([EXTERNAL])
  })
})
