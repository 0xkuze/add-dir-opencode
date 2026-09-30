import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { pathToFileURL } from "url"
import { createTestEnvironment } from "./environment"
import { AddDirPlugin } from "../src/plugin"
import { AddDirServerV2 } from "../src/v2-plugin"
import { freshDirs, invalidateCache, initializeSessionDirs } from "../src/state"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"

let environment: ReturnType<typeof createTestEnvironment>
let TMP: string
let PROJECT: string
let EXTERNAL: string

type PluginContext = Parameters<typeof AddDirServerV2.setup>[0]

type Registered = {
  evaluate?: (event: PermissionEvaluation) => Promise<void> | void
  context?: (event: { system: { type: string; text: string }[] }) => Promise<void> | void
}

async function createV2Plugin(plugin = AddDirServerV2) {
  const registered: Registered = {}
  const registration = { dispose: async () => {} }
  const ctx = {
    permission: {
      hook: async (name: string, callback: never) => {
        registered[name as keyof Registered] = callback as never
        return registration
      },
    },
    session: {
      hook: async (name: string, callback: never) => {
        registered[name as keyof Registered] = callback as never
        return registration
      },
    },
  } as unknown as PluginContext
  await plugin.setup(ctx)
  return { registered }
}

function permissionEvent(action: string, resources: string[], effect: "allow" | "ask" | "deny" = "ask"): PermissionEvaluation {
  return { sessionID: "s1", action, resources, effect } as unknown as PermissionEvaluation
}

function persistDir(dirPath: string) {
  const dir = join(process.env["XDG_DATA_HOME"]!, "opencode", "add-dir")
  mkdirSync(dir, { recursive: true })
  const file = join(dir, "directories.json")
  writeFileSync(file, JSON.stringify([dirPath], null, 2))
  invalidateCache()
}

beforeEach(() => {
  environment = createTestEnvironment("add-dir-v2-test-")
  TMP = environment.root
  PROJECT = join(TMP, "project")
  EXTERNAL = join(TMP, "external")
  mkdirSync(PROJECT, { recursive: true })
  mkdirSync(EXTERNAL, { recursive: true })
})

afterEach(() => {
  environment.cleanup()
  invalidateCache()
})

describe("AddDirServerV2", () => {
  test("has a stable id", () => {
    expect(AddDirServerV2.id).toBe("opencode-add-dir")
  })

  test("registers the permission and session hooks", async () => {
    const { registered } = await createV2Plugin()
    expect(typeof registered.evaluate).toBe("function")
    expect(typeof registered.context).toBe("function")
  })

  test("clears session-only dirs on setup", async () => {
    const dir = join(process.env["XDG_DATA_HOME"]!, "opencode", "add-dir")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "session-dirs.json"), JSON.stringify([EXTERNAL]))
    expect(freshDirs().has(EXTERNAL)).toBe(true)
    await createV2Plugin()
    expect(existsSync(join(dir, "session-dirs.json"))).toBe(false)
    expect(freshDirs().has(EXTERNAL)).toBe(false)
  })

  test("preserves active directories across instances and module reloads", async () => {
    const { registered } = await createV2Plugin()
    const dir = join(process.env["XDG_DATA_HOME"]!, "opencode", "add-dir")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "session-dirs.json"), JSON.stringify([EXTERNAL]))
    invalidateCache()
    await createV2Plugin()
    const moduleUrl = `${pathToFileURL(join(import.meta.dir, "../src/v2-plugin.ts")).href}?reload=${Date.now()}`
    const reloaded = await import(moduleUrl) as { AddDirServerV2: typeof AddDirServerV2 }
    await createV2Plugin(reloaded.AddDirServerV2)
    const stateUrl = `${pathToFileURL(join(import.meta.dir, "../src/state.ts")).href}?reload=${Date.now()}`
    const reloadedState = await import(stateUrl) as { initializeSessionDirs: typeof initializeSessionDirs }
    reloadedState.initializeSessionDirs()
    expect(existsSync(join(dir, "session-dirs.json"))).toBe(true)
    const event = permissionEvent("external_directory", [EXTERNAL])
    await registered.evaluate!(event)
    expect(event.effect).toBe("allow")
  })

  test("clears session state again when a new server process starts", async () => {
    await createV2Plugin()
    const dir = join(process.env["XDG_DATA_HOME"]!, "opencode", "add-dir")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "session-dirs.json"), JSON.stringify([EXTERNAL]))
    const child = Bun.spawn([
      "bun", "--eval",
      'import { initializeSessionDirs } from "./src/state.ts"; initializeSessionDirs()',
    ], { cwd: join(import.meta.dir, ".."), env: { ...process.env }, stdout: "pipe", stderr: "pipe" })
    const [exitCode, , stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    expect(existsSync(join(dir, "session-dirs.json"))).toBe(false)
  })

  test("shares startup cleanup between V1 and V2", async () => {
    await AddDirPlugin({ client: {} } as Parameters<typeof AddDirPlugin>[0])
    const dir = join(process.env["XDG_DATA_HOME"]!, "opencode", "add-dir")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "session-dirs.json"), JSON.stringify([EXTERNAL]))
    invalidateCache()
    const { registered } = await createV2Plugin()
    const event = permissionEvent("external_directory", [EXTERNAL])
    await registered.evaluate!(event)
    expect(event.effect).toBe("allow")
  })
})

describe("permission evaluate hook", () => {
  test("requires every resource to be approved, regardless of order", async () => {
    const { registered } = await createV2Plugin()
    persistDir(EXTERNAL)
    const approved = join(EXTERNAL, "*")
    const unapproved = join(TMP, "private", "*")
    for (const resources of [[approved, unapproved], [unapproved, approved]]) {
      const event = permissionEvent("external_directory", resources)
      await registered.evaluate!(event)
      expect(event.effect).toBe("ask")
    }
  })

  test("allows multiple resources when all are approved", async () => {
    const { registered } = await createV2Plugin()
    persistDir(EXTERNAL)
    const event = permissionEvent("external_directory", [EXTERNAL, join(EXTERNAL, "child", "*")])
    await registered.evaluate!(event)
    expect(event.effect).toBe("allow")
  })

  test("does not approve an empty resource list or a sibling prefix", async () => {
    const { registered } = await createV2Plugin()
    persistDir(EXTERNAL)
    for (const resources of [[], [`${EXTERNAL}-private/*`]]) {
      const event = permissionEvent("external_directory", resources)
      await registered.evaluate!(event)
      expect(event.effect).toBe("ask")
    }
  })

  test("preserves existing allow and deny decisions", async () => {
    const { registered } = await createV2Plugin()
    persistDir(EXTERNAL)
    for (const effect of ["allow", "deny"] as const) {
      const event = permissionEvent("external_directory", [EXTERNAL], effect)
      await registered.evaluate!(event)
      expect(event.effect).toBe(effect)
    }
  })
  test("allows an external_directory resource under an added dir", async () => {
    const { registered } = await createV2Plugin()
    persistDir(EXTERNAL)
    const event = permissionEvent("external_directory", [join(EXTERNAL, "*")])
    await registered.evaluate!(event)
    expect(event.effect).toBe("allow")
  })

  test("allows a resource without the trailing wildcard", async () => {
    const { registered } = await createV2Plugin()
    persistDir(EXTERNAL)
    const event = permissionEvent("external_directory", [EXTERNAL])
    await registered.evaluate!(event)
    expect(event.effect).toBe("allow")
  })

  test("leaves unrelated directories asking", async () => {
    const { registered } = await createV2Plugin()
    persistDir(EXTERNAL)
    const event = permissionEvent("external_directory", [join(TMP, "other", "*")])
    await registered.evaluate!(event)
    expect(event.effect).toBe("ask")
  })

  test("ignores other actions", async () => {
    const { registered } = await createV2Plugin()
    persistDir(EXTERNAL)
    const event = permissionEvent("read", [join(EXTERNAL, "f.ts")])
    await registered.evaluate!(event)
    expect(event.effect).toBe("ask")
  })

  test("leaves the decision asking when no dirs are added", async () => {
    const { registered } = await createV2Plugin()
    const event = permissionEvent("external_directory", [join(EXTERNAL, "*")])
    await registered.evaluate!(event)
    expect(event.effect).toBe("ask")
  })
})

describe("session context hook", () => {
  test("injects the directory list into the system prompt", async () => {
    const { registered } = await createV2Plugin()
    persistDir(EXTERNAL)
    const event = { system: [] as { type: string; text: string }[] }
    await registered.context!(event)
    expect(event.system.length).toBe(1)
    expect(event.system[0]!.type).toBe("text")
    expect(event.system[0]!.text).toContain(EXTERNAL)
    expect(event.system[0]!.text).toContain("working directories")
  })

  test("does not inject when no dirs are added", async () => {
    const { registered } = await createV2Plugin()
    const event = { system: [] as { type: string; text: string }[] }
    await registered.context!(event)
    expect(event.system.length).toBe(0)
  })
})
