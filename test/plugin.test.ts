import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { createTestEnvironment } from "./environment"
import type { Config, Hooks, PluginInput } from "@opencode-ai/plugin"
import { AddDirPlugin } from "../src/plugin"
import { invalidateCache, expandHome, freshDirs, isChildOf, matchesDirs } from "../src/state"
import { extractPath, shouldGrantBeforeTool, permissionGlob, resetGrantedSessions } from "../src/permissions"
import { collectAgentContext } from "../src/context"
import type { ToolArgs } from "../src/types"
import type { DirEntry } from "../src/state"

let environment: ReturnType<typeof createTestEnvironment>
let TMP: string
let PROJECT: string
let EXTERNAL: string

interface PromptCall {
  path: { id: string }
  body: { noReply: boolean; tools?: Record<string, boolean>; parts: { type: string; text: string }[] }
}

interface PermReplyCall {
  path: { id: string; permissionID: string }
  body: { response: string }
}

type Call =
  | { method: "prompt"; args: PromptCall }
  | { method: "promptAsync"; args: PromptCall }
  | { method: "permReply"; args: PermReplyCall }

function mockClient() {
  const calls: Call[] = []
  return {
    calls,
    session: {
      prompt: async (o: PromptCall) => { calls.push({ method: "prompt", args: o }); return {} },
      promptAsync: async (o: PromptCall) => { calls.push({ method: "promptAsync", args: o }); return {} },
    },
    postSessionIdPermissionsPermissionId: async (o: PermReplyCall) => {
      calls.push({ method: "permReply", args: o }); return {}
    },
  }
}

function findPromptCall(calls: Call[], method: "prompt" | "promptAsync", predicate?: (args: PromptCall) => boolean) {
  return calls.find((c): c is Extract<Call, { method: typeof method }> =>
    c.method === method && (!predicate || predicate(c.args as PromptCall)),
  )
}

function findPermReplyCall(calls: Call[]) {
  return calls.find((c): c is Extract<Call, { method: "permReply" }> => c.method === "permReply")
}

function writeToStateFile(filename: string, dirPath: string) {
  const dir = join(process.env["XDG_DATA_HOME"]!, "opencode", "add-dir")
  const file = join(dir, filename)
  mkdirSync(dir, { recursive: true })
  const existing = existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) as string[] : []
  if (!existing.includes(dirPath)) writeFileSync(file, JSON.stringify([...existing, dirPath], null, 2))
  invalidateCache()
}

function persistDir(dirPath: string) { writeToStateFile("directories.json", dirPath) }
function sessionDir(dirPath: string) { writeToStateFile("session-dirs.json", dirPath) }

async function createPlugin(client = mockClient()) {
  const input: PluginInput = {
    client: client as unknown as PluginInput["client"],
    project: {} as PluginInput["project"],
    directory: PROJECT,
    worktree: PROJECT,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost:4096"),
    $: (() => {}) as unknown as PluginInput["$"],
  }
  return { hooks: await AddDirPlugin(input), client }
}

type EventInput = Parameters<NonNullable<Hooks["event"]>>[0]
type ToolBeforeInput = Parameters<NonNullable<Hooks["tool.execute.before"]>>[0]
type ToolBeforeOutput = Parameters<NonNullable<Hooks["tool.execute.before"]>>[1]
type SystemTransformInput = Parameters<NonNullable<Hooks["experimental.chat.system.transform"]>>[0]
type SystemTransformOutput = Parameters<NonNullable<Hooks["experimental.chat.system.transform"]>>[1]

function permissionEvent(id: string, sessionID: string, filepath: string, parentDir: string, patterns: string[]): EventInput {
  return {
    event: {
      type: "permission.asked",
      properties: { id, sessionID, permission: "external_directory", patterns, metadata: { filepath, parentDir }, always: patterns },
    } as unknown as EventInput["event"],
  }
}

beforeEach(() => {
  environment = createTestEnvironment("add-dir-v1-test-")
  TMP = environment.root
  PROJECT = join(TMP, "project")
  EXTERNAL = join(TMP, "external")
  mkdirSync(PROJECT, { recursive: true })
  mkdirSync(EXTERNAL, { recursive: true })
})

afterEach(() => {
  environment.cleanup()
  invalidateCache()
  resetGrantedSessions()
})

// ── state.ts ──

describe("expandHome", () => {
  test("expands ~/path", () => {
    const home = process.env["HOME"]!
    expect(expandHome("~/foo")).toBe(join(home, "foo"))
  })

  test("leaves absolute paths unchanged", () => {
    expect(expandHome("/usr/local")).toBe("/usr/local")
  })

  test("leaves relative paths unchanged", () => {
    expect(expandHome("relative/path")).toBe("relative/path")
  })
})

describe("isChildOf", () => {
  test("returns true for exact match", () => {
    expect(isChildOf("/a/b", "/a/b")).toBe(true)
  })

  test("returns true for child path", () => {
    expect(isChildOf("/a/b", "/a/b/c/d")).toBe(true)
  })

  test("returns false for unrelated path", () => {
    expect(isChildOf("/a/b", "/a/c")).toBe(false)
  })

  test("returns false for partial prefix match", () => {
    expect(isChildOf("/a/bar", "/a/barbaz")).toBe(false)
  })
})

describe("matchesDirs", () => {
  test("matches child of entries", () => {
    const dirs = new Map<string, DirEntry>([
      ["/a", { path: "/a", persist: true }],
      ["/b", { path: "/b", persist: true }],
    ])
    expect(matchesDirs(dirs, "/a/file.ts")).toBe(true)
    expect(matchesDirs(dirs, "/b/sub/file.ts")).toBe(true)
  })

  test("returns false for unrelated path", () => {
    const dirs = new Map<string, DirEntry>([["/a", { path: "/a", persist: true }]])
    expect(matchesDirs(dirs, "/c/file.ts")).toBe(false)
  })

  test("returns false for empty dirs", () => {
    expect(matchesDirs(new Map(), "/x")).toBe(false)
  })
})

describe("freshDirs", () => {
  test("returns empty map when no file exists", () => {
    expect(freshDirs().size).toBe(0)
  })

  test("reads persisted dirs from file", () => {
    persistDir(EXTERNAL)
    const dirs = freshDirs()
    expect(dirs.has(EXTERNAL)).toBe(true)
    expect(dirs.get(EXTERNAL)!.persist).toBe(true)
  })

  test("returns cached result on same mtime", () => {
    persistDir(EXTERNAL)
    const a = freshDirs()
    const b = freshDirs()
    expect(a).toBe(b)
  })

  test("reloads after invalidateCache", () => {
    persistDir(EXTERNAL)
    const a = freshDirs()
    invalidateCache()
    const b = freshDirs()
    expect(a).not.toBe(b)
    expect(b.has(EXTERNAL)).toBe(true)
  })

  test("merges session dirs from session-dirs.json", () => {
    const sessionDir2 = join(TMP, "session-ext")
    mkdirSync(sessionDir2, { recursive: true })
    persistDir(EXTERNAL)
    sessionDir(sessionDir2)
    const dirs = freshDirs()
    expect(dirs.has(EXTERNAL)).toBe(true)
    expect(dirs.get(EXTERNAL)!.persist).toBe(true)
    expect(dirs.has(sessionDir2)).toBe(true)
    expect(dirs.get(sessionDir2)!.persist).toBe(false)
  })

  test("persisted entry takes priority over session entry for same path", () => {
    persistDir(EXTERNAL)
    sessionDir(EXTERNAL)
    const dirs = freshDirs()
    expect(dirs.get(EXTERNAL)!.persist).toBe(true)
  })
})

// ── permissions.ts ──

describe("permissionGlob", () => {
  test("appends wildcard", () => {
    expect(permissionGlob("/a/b")).toBe(join("/a/b", "*"))
  })
})

describe("extractPath", () => {
  test("extracts filePath for read", () => {
    expect(extractPath("read", { filePath: "/a/b" })).toBe("/a/b")
  })

  test("extracts path for glob", () => {
    expect(extractPath("glob", { path: "/a" })).toBe("/a")
  })

  test("extracts pattern for grep", () => {
    expect(extractPath("grep", { pattern: "/a/*.ts" })).toBe("/a/*.ts")
  })

  test("extracts workdir for bash", () => {
    expect(extractPath("bash", { workdir: "/a" })).toBe("/a")
  })

  test("falls back to command for bash without workdir", () => {
    expect(extractPath("bash", { command: "ls /a" })).toBe("ls /a")
  })

  test("returns empty for null args", () => {
    expect(extractPath("read", null as unknown as ToolArgs)).toBe("")
  })

  test("returns empty for missing fields", () => {
    expect(extractPath("read", {})).toBe("")
  })
})

describe("shouldGrantBeforeTool", () => {
  let dirs: Map<string, DirEntry>
  beforeEach(() => {
    dirs = new Map([[EXTERNAL, { path: EXTERNAL, persist: true }]])
  })

  test("returns true for file tool accessing added dir", () => {
    expect(shouldGrantBeforeTool(dirs, "read", { filePath: join(EXTERNAL, "f.ts") })).toBe(true)
  })

  test("returns false for non-file tool", () => {
    expect(shouldGrantBeforeTool(dirs, "webfetch", { filePath: join(EXTERNAL, "f") })).toBe(false)
  })

  test("returns false for unrelated path", () => {
    expect(shouldGrantBeforeTool(dirs, "read", { filePath: "/other/f" })).toBe(false)
  })

  test("returns false for empty dirs", () => {
    expect(shouldGrantBeforeTool(new Map(), "read", { filePath: EXTERNAL })).toBe(false)
  })

  test("returns false for empty args", () => {
    expect(shouldGrantBeforeTool(dirs, "read", {})).toBe(false)
  })
})

// ── context.ts ──

describe("collectAgentContext", () => {
  test("includes directory list as first section", () => {
    const dirs = new Map<string, DirEntry>([[EXTERNAL, { path: EXTERNAL, persist: true }]])
    const result = collectAgentContext(dirs)
    expect(result[0]).toContain(EXTERNAL)
    expect(result[0]).toContain("working directories")
  })

  test("skips context files when env var is not set", () => {
    const dir = join(TMP, "ctx-skip")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "AGENTS.md"), "# Rules")
    const dirs = new Map<string, DirEntry>([[dir, { path: dir, persist: true }]])
    const result = collectAgentContext(dirs)
    expect(result.length).toBe(1)
    expect(result[0]).not.toContain("Rules")
  })

  describe("with OPENCODE_ADDDIR_INJECT_CONTEXT=1", () => {
    beforeEach(() => { process.env["OPENCODE_ADDDIR_INJECT_CONTEXT"] = "1" })
    afterEach(() => { delete process.env["OPENCODE_ADDDIR_INJECT_CONTEXT"] })

    test("collects AGENTS.md after directory list", () => {
      const dir = join(TMP, "ctx-agents")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "AGENTS.md"), "# Agent rules")
      const dirs = new Map<string, DirEntry>([[dir, { path: dir, persist: true }]])
      const result = collectAgentContext(dirs)
      expect(result.length).toBe(2)
      expect(result[1]).toContain("Agent rules")
      expect(result[1]).toContain("Context from")
    })

    test("collects CLAUDE.md", () => {
      const dir = join(TMP, "ctx-claude")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "CLAUDE.md"), "# Claude rules")
      const dirs = new Map<string, DirEntry>([[dir, { path: dir, persist: true }]])
      expect(collectAgentContext(dirs).some((s) => s.includes("Claude rules"))).toBe(true)
    })

    test("collects .agents/AGENTS.md", () => {
      const dir = join(TMP, "ctx-dotagents")
      mkdirSync(join(dir, ".agents"), { recursive: true })
      writeFileSync(join(dir, ".agents", "AGENTS.md"), "# Nested rules")
      const dirs = new Map<string, DirEntry>([[dir, { path: dir, persist: true }]])
      expect(collectAgentContext(dirs).some((s) => s.includes("Nested rules"))).toBe(true)
    })

    test("collects multiple context files from same dir", () => {
      const dir = join(TMP, "ctx-multi")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "AGENTS.md"), "# A")
      writeFileSync(join(dir, "CLAUDE.md"), "# B")
      const dirs = new Map<string, DirEntry>([[dir, { path: dir, persist: true }]])
      expect(collectAgentContext(dirs).length).toBe(3)
    })

    test("collects from multiple dirs", () => {
      const d1 = join(TMP, "ctx-d1")
      const d2 = join(TMP, "ctx-d2")
      mkdirSync(d1, { recursive: true })
      mkdirSync(d2, { recursive: true })
      writeFileSync(join(d1, "AGENTS.md"), "# D1")
      writeFileSync(join(d2, "AGENTS.md"), "# D2")
      const dirs = new Map<string, DirEntry>([
        [d1, { path: d1, persist: true }],
        [d2, { path: d2, persist: true }],
      ])
      expect(collectAgentContext(dirs).length).toBe(3)
    })

    test("skips empty context files", () => {
      const dir = join(TMP, "ctx-empty")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "AGENTS.md"), "   ")
      const dirs = new Map<string, DirEntry>([[dir, { path: dir, persist: true }]])
      expect(collectAgentContext(dirs).length).toBe(1)
    })
  })

  test("returns only directory list when no context files exist", () => {
    const dirs = new Map<string, DirEntry>([[EXTERNAL, { path: EXTERNAL, persist: true }]])
    expect(collectAgentContext(dirs).length).toBe(1)
  })

  test("returns empty for empty dirs map", () => {
    expect(collectAgentContext(new Map()).length).toBe(0)
  })
})

// ── plugin.ts hooks ──

describe("config hook", () => {
  test("preserves session directories when another V1 instance starts", async () => {
    const { hooks } = await createPlugin()
    sessionDir(EXTERNAL)
    await createPlugin()
    const cfg = {} as Config
    await hooks.config!(cfg)
    const extDir = (cfg as Record<string, Record<string, Record<string, string>>>).permission.external_directory
    expect(extDir[join(EXTERNAL, "*")]).toBe("allow")
  })

  test("injects permission rules for persisted dirs", async () => {
    const { hooks } = await createPlugin()
    persistDir(EXTERNAL)
    const cfg = {} as Config
    await hooks.config!(cfg)
    const perm = (cfg as Record<string, Record<string, Record<string, string>>>).permission
    expect(perm.external_directory[join(EXTERNAL, "*")]).toBe("allow")
  })

  test("injects rules for multiple dirs", async () => {
    const dir2 = join(TMP, "ext2")
    mkdirSync(dir2, { recursive: true })
    const { hooks } = await createPlugin()
    persistDir(EXTERNAL)
    persistDir(dir2)
    const cfg = {} as Config
    await hooks.config!(cfg)
    const extDir = (cfg as Record<string, Record<string, Record<string, string>>>).permission.external_directory
    expect(extDir[join(EXTERNAL, "*")]).toBe("allow")
    expect(extDir[join(dir2, "*")]).toBe("allow")
  })

  test("skips permission injection when no dirs", async () => {
    const { hooks } = await createPlugin()
    const cfg = {} as Config
    await hooks.config!(cfg)
    expect((cfg as Record<string, unknown>).permission).toBeUndefined()
  })

  test("does not expose tools", async () => {
    const { hooks } = await createPlugin()
    expect(hooks.tool).toBeUndefined()
  })
})

describe("tool.execute.before hook", () => {
  test("grants permission for subagent accessing added dir", async () => {
    const { hooks, client } = await createPlugin()
    persistDir(EXTERNAL)
    const input: ToolBeforeInput = { tool: "read", sessionID: "sub-1", callID: "c1" }
    const output: ToolBeforeOutput = { args: { filePath: join(EXTERNAL, "f.ts") } }
    await hooks["tool.execute.before"]!(input, output)
    expect(findPromptCall(client.calls, "prompt", (a) => a.path.id === "sub-1")).toBeDefined()
  })

  test("caches grant per session", async () => {
    const { hooks, client } = await createPlugin()
    persistDir(EXTERNAL)
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "sub-2", callID: "c1" }, { args: { filePath: join(EXTERNAL, "a") } })
    await hooks["tool.execute.before"]!({ tool: "glob", sessionID: "sub-2", callID: "c2" }, { args: { path: EXTERNAL } })
    expect(client.calls.filter((c) => c.method === "prompt" && (c.args as PromptCall).path.id === "sub-2").length).toBe(1)
  })

  test("ignores unrelated paths", async () => {
    const { hooks, client } = await createPlugin()
    persistDir(EXTERNAL)
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "sub-3", callID: "c1" }, { args: { filePath: "/other/f" } })
    expect(client.calls.filter((c) => c.method === "prompt").length).toBe(0)
  })

  test("ignores non-file tools", async () => {
    const { hooks, client } = await createPlugin()
    persistDir(EXTERNAL)
    await hooks["tool.execute.before"]!({ tool: "webfetch", sessionID: "sub-4", callID: "c1" }, { args: { filePath: join(EXTERNAL, "x") } })
    expect(client.calls.filter((c) => c.method === "prompt").length).toBe(0)
  })

  test("grants permission for session-only dirs", async () => {
    const { hooks, client } = await createPlugin()
    sessionDir(EXTERNAL)
    await hooks["tool.execute.before"]!(
      { tool: "read", sessionID: "sub-5", callID: "c1" },
      { args: { filePath: join(EXTERNAL, "f.ts") } },
    )
    expect(findPromptCall(client.calls, "prompt", (a) => a.path.id === "sub-5")).toBeDefined()
  })
})

describe("event auto-approve hook", () => {
  test("approves matching filepath", async () => {
    const { hooks, client } = await createPlugin()
    persistDir(EXTERNAL)
    await hooks.event!(permissionEvent("p1", "sub", join(EXTERNAL, "f"), EXTERNAL, [join(EXTERNAL, "*")]))
    const r = findPermReplyCall(client.calls)
    expect(r).toBeDefined()
    expect(r!.args.body.response).toBe("always")
    expect(r!.args.path.permissionID).toBe("p1")
  })

  test("approves matching parentDir", async () => {
    const { hooks, client } = await createPlugin()
    persistDir(EXTERNAL)
    await hooks.event!(permissionEvent("p4", "sub", "", EXTERNAL, []))
    expect(findPermReplyCall(client.calls)).toBeDefined()
  })

  test("approves matching pattern", async () => {
    const { hooks, client } = await createPlugin()
    persistDir(EXTERNAL)
    await hooks.event!(permissionEvent("p2", "sub", "", "", [join(EXTERNAL, "*")]))
    expect(findPermReplyCall(client.calls)).toBeDefined()
  })

  test("ignores unrelated dirs", async () => {
    const { hooks, client } = await createPlugin()
    await hooks.event!(permissionEvent("p3", "s", "/other/f", "/other", ["/other/*"]))
    expect(findPermReplyCall(client.calls)).toBeUndefined()
  })

  test("ignores non-permission events", async () => {
    const { hooks, client } = await createPlugin()
    await hooks.event!({ event: { type: "session.idle" } } as EventInput)
    expect(client.calls.length).toBe(0)
  })

  test("ignores non-external_directory permission", async () => {
    const { hooks, client } = await createPlugin()
    persistDir(EXTERNAL)
    const evt: EventInput = {
      event: {
        type: "permission.asked",
        properties: { id: "x", sessionID: "s", permission: "other", patterns: [], metadata: {}, always: [] },
      } as unknown as EventInput["event"],
    }
    await hooks.event!(evt)
    expect(findPermReplyCall(client.calls)).toBeUndefined()
  })

  test("ignores events without id", async () => {
    const { hooks, client } = await createPlugin()
    persistDir(EXTERNAL)
    const evt: EventInput = {
      event: {
        type: "permission.asked",
        properties: { id: "", sessionID: "s", permission: "external_directory", patterns: [join(EXTERNAL, "*")], metadata: { filepath: join(EXTERNAL, "f") }, always: [] },
      } as unknown as EventInput["event"],
    }
    await hooks.event!(evt)
    expect(findPermReplyCall(client.calls)).toBeUndefined()
  })
})

describe("system.transform hook", () => {
  test("injects directory list into system prompt", async () => {
    const { hooks } = await createPlugin()
    persistDir(EXTERNAL)
    const input = { model: {} } as SystemTransformInput
    const output: SystemTransformOutput = { system: [] }
    await hooks["experimental.chat.system.transform"]!(input, output)
    expect(output.system[0]).toContain(EXTERNAL)
    expect(output.system[0]).toContain("working directories")
  })

  test("does not inject context files by default", async () => {
    const dir = join(TMP, "agents")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "AGENTS.md"), "# Rules")
    const { hooks } = await createPlugin()
    persistDir(dir)
    const input = { model: {} } as SystemTransformInput
    const output: SystemTransformOutput = { system: [] }
    await hooks["experimental.chat.system.transform"]!(input, output)
    expect(output.system.length).toBe(1)
    expect(output.system[0]).not.toContain("Rules")
  })

  test("returns only directory list when no context files exist", async () => {
    const { hooks } = await createPlugin()
    persistDir(EXTERNAL)
    const input = { model: {} } as SystemTransformInput
    const output: SystemTransformOutput = { system: [] }
    await hooks["experimental.chat.system.transform"]!(input, output)
    expect(output.system.length).toBe(1)
    expect(output.system[0]).toContain(EXTERNAL)
  })

  test("returns empty when no dirs", async () => {
    const { hooks } = await createPlugin()
    const input = { model: {} } as SystemTransformInput
    const output: SystemTransformOutput = { system: [] }
    await hooks["experimental.chat.system.transform"]!(input, output)
    expect(output.system.length).toBe(0)
  })
})
