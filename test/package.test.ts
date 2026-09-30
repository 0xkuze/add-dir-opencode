import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { pathToFileURL } from "url"

import { beforeAll, beforeEach, afterEach, describe, expect, test } from "bun:test"
import { createTestEnvironment } from "./environment"

const ROOT = join(import.meta.dir, "..")
const DIST = join(ROOT, "dist")
let environment: ReturnType<typeof createTestEnvironment>

beforeEach(() => { environment = createTestEnvironment("add-dir-package-test-") })
afterEach(() => environment.cleanup())

interface Command {
  value: string
}

type CommandFactory = () => Command[]

interface TuiApi {
  command: {
    register: (factory: CommandFactory) => void
  }
}

interface V2KeymapCommand {
  id?: string
  title?: string
  slash?: { name: string }
}

interface V2KeymapLayer {
  mode?: string
  commands?: readonly V2KeymapCommand[]
}

interface V2SlotClaim {
  render: () => unknown
}

interface V2TuiContext {
  keymap: {
    layer: (input: () => V2KeymapLayer) => void
  }
  ui: {
    slot: (claim: V2SlotClaim) => () => void
  }
}

interface TuiModule {
  default: {
    id: string
    tui: (api: TuiApi) => Promise<void>
    setup: (context: V2TuiContext) => Promise<void>
  }
}

interface ServerModule {
  default: {
    id: string
    server: () => Promise<unknown>
    setup: (context: unknown) => Promise<unknown>
  }
}

interface CommandResult {
  stdout: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseTuiExport(content: string): string {
  const manifest: unknown = JSON.parse(content)
  if (!isRecord(manifest) || !isRecord(manifest.exports)) {
    throw new Error("package manifest has no exports")
  }

  const tui = manifest.exports["./tui"]
  if (!isRecord(tui) || typeof tui.import !== "string") {
    throw new Error("package manifest has no TUI import")
  }
  return tui.import
}

function parsePackFiles(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.match(/^packed \S+ (.+)$/)?.[1])
    .filter((file): file is string => Boolean(file))
}

function isTuiModule(value: unknown): value is TuiModule {
  if (!isRecord(value) || !isRecord(value.default)) return false
  return (
    typeof value.default.id === "string" &&
    typeof value.default.tui === "function" &&
    typeof value.default.setup === "function"
  )
}

function isServerModule(value: unknown): value is ServerModule {
  if (!isRecord(value) || !isRecord(value.default)) return false
  return (
    typeof value.default.id === "string" &&
    typeof value.default.server === "function" &&
    typeof value.default.setup === "function"
  )
}

async function runCommand(command: string[]): Promise<CommandResult> {
  const child = Bun.spawn(command, {
    cwd: ROOT,
    stderr: "pipe",
    stdout: "pipe",
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const [exitCode, output, errorOutput] = await Promise.all([child.exited, stdout, stderr])

  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${exitCode}): ${errorOutput}`)
  }
  return { stdout: output }
}

beforeAll(async () => {
  await runCommand(["bun", "run", "build"])
})

describe("publishable package", () => {
  test("exports a compiled TUI entry", () => {
    const manifest = readFileSync(join(ROOT, "package.json"), "utf-8")
    const tuiExport = parseTuiExport(manifest)

    expect(tuiExport).toBe("./dist/tui.js")
    expect(existsSync(join(ROOT, tuiExport))).toBe(true)
    expect(existsSync(join(DIST, "tui.tsx"))).toBe(false)

    const tui = readFileSync(join(DIST, "tui.js"), "utf-8")
    expect(tui).not.toContain("react/jsx")
    expect(tui).not.toContain("jsx-dev-runtime")
  })

  test("includes both runtime entries without source files", async () => {
    const result = await runCommand(["bun", "pm", "pack", "--dry-run", "--ignore-scripts"])
    const files = parsePackFiles(result.stdout)

    expect(files).toContain("dist/index.js")
    expect(files).toContain("dist/tui.js")
    expect(files.some((file) => file.endsWith(".tsx"))).toBe(false)
    expect(files.some((file) => file.startsWith("src/"))).toBe(false)
    expect(files.some((file) => file.startsWith("scripts/"))).toBe(false)
  })

  test("loads the TUI module and registers every command", async () => {
    const moduleUrl = `${pathToFileURL(join(DIST, "tui.js")).href}?test=${Date.now()}`
    const loaded: unknown = await import(moduleUrl)
    if (!isTuiModule(loaded)) throw new Error("built TUI module has an invalid export")

    let commandFactory: CommandFactory | undefined
    await loaded.default.tui({
      command: {
        register(factory): void {
          commandFactory = factory
        },
      },
    })

    expect(loaded.default.id).toBe("opencode-add-dir")
    expect(commandFactory?.().map((command) => command.value)).toEqual([
      "add-dir",
      "list-dir",
      "remove-dir",
    ])
  })

  test("loads the TUI module's V2 setup and registers every slash command", async () => {
    const moduleUrl = `${pathToFileURL(join(DIST, "tui.js")).href}?test=${Date.now()}`
    const loaded: unknown = await import(moduleUrl)
    if (!isTuiModule(loaded)) throw new Error("built TUI module has an invalid export")

    let layer: V2KeymapLayer | undefined
    const claims: V2SlotClaim[] = []
    const context: V2TuiContext = {
      keymap: {
        layer(input): void {
          layer = input()
        },
      },
      ui: {
        slot(claim): () => void {
          claims.push(claim)
          return () => {}
        },
      },
    }
    const cleanup = await loaded.default.setup(context)
    expect(typeof cleanup).toBe("function")
    expect(claims.length).toBe(1)

    // The layer registers from inside the slot render, where the host
    // provides the keymap Solid context.
    claims[0]!.render()
    expect(layer?.commands?.map((command) => command.slash?.name)).toEqual([
      "add-dir",
      "list-dir",
      "remove-dir",
    ])
  })

  test("loads the server module with both V1 and V2 entrypoints", async () => {
    const moduleUrl = `${pathToFileURL(join(DIST, "index.js")).href}?test=${Date.now()}`
    const loaded: unknown = await import(moduleUrl)
    if (!isServerModule(loaded)) throw new Error("built server module has an invalid export")

    expect(loaded.default.id).toBe("opencode-add-dir")
    // V1 calls server(); V2 calls setup(). V1 hook coverage lives in
    // plugin.test.ts; here we verify the dual shape and that V2 setup
    // registers its hooks against a stub context.
    expect(typeof loaded.default.server).toBe("function")
    const registered: string[] = []
    const registration = { dispose: async () => {} }
    const state = join(process.env["XDG_DATA_HOME"]!, "opencode", "add-dir")
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, "session-dirs.json"), JSON.stringify(["/old-session"]))
    writeFileSync(join(state, "directories.json"), JSON.stringify(["/remembered"]))
    await loaded.default.setup({
      permission: { hook: async () => registered.push("evaluate") || registration },
      session: { hook: async () => registered.push("context") || registration },
    } as unknown as Parameters<typeof loaded.default.setup>[0])
    expect(registered).toEqual(["evaluate", "context"])
    expect(existsSync(join(state, "session-dirs.json"))).toBe(false)
    expect(JSON.parse(readFileSync(join(state, "directories.json"), "utf-8"))).toEqual(["/remembered"])
  })
})
