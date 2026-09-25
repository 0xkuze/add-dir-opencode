import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AddDirServerV2 } from "../src/v2-plugin"
import { invalidateCache } from "../src/state"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"

const TMP = join(tmpdir(), "add-dir-v2-test")
const PROJECT = join(TMP, "project")
const EXTERNAL = join(TMP, "external")

type PluginContext = Parameters<typeof AddDirServerV2.setup>[0]

type Registered = {
  evaluate?: (event: PermissionEvaluation) => Promise<void> | void
  context?: (event: { system: { type: string; text: string }[] }) => Promise<void> | void
}

async function createV2Plugin() {
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
  await AddDirServerV2.setup(ctx)
  return { registered }
}

function permissionEvent(action: string, resources: string[], effect: "allow" | "ask" = "ask"): PermissionEvaluation {
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
  mkdirSync(PROJECT, { recursive: true })
  mkdirSync(EXTERNAL, { recursive: true })
  process.env["XDG_DATA_HOME"] = join(TMP, "data")
})

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
  delete process.env["XDG_DATA_HOME"]
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
    await createV2Plugin()
    expect(existsSync(join(dir, "session-dirs.json"))).toBe(false)
  })
})

describe("permission evaluate hook", () => {
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
