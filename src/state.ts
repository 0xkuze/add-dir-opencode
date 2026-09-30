import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, unlinkSync } from "fs"
import { join } from "path"

function stateDir() {
  return join(
    process.env["XDG_DATA_HOME"] || join(process.env["HOME"] || "~", ".local", "share"),
    "opencode",
    "add-dir",
  )
}

export function persistedFile() { return join(stateDir(), "directories.json") }
export function sessionFile() { return join(stateDir(), "session-dirs.json") }

export interface DirEntry {
  path: string
  persist: boolean
}

export function expandHome(p: string) {
  return p.startsWith("~/") ? (process.env["HOME"] || "~") + p.slice(1) : p
}

export function readJsonArray(file: string): string[] {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf-8"))
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : []
  } catch { return [] }
}

export function writeJsonArray(file: string, items: string[]) {
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(file, JSON.stringify(items, null, 2))
  invalidateCache()
}

function loadDirs(): Map<string, DirEntry> {
  const dirs = new Map<string, DirEntry>()
  for (const p of readJsonArray(persistedFile())) dirs.set(p, { path: p, persist: true })
  for (const p of readJsonArray(sessionFile())) if (!dirs.has(p)) dirs.set(p, { path: p, persist: false })
  return dirs
}

let cachedDirs: Map<string, DirEntry> | undefined
let cachedMtime = 0
let lastCheckMs = 0
const CACHE_TTL_MS = 500

export function freshDirs(): Map<string, DirEntry> {
  const now = Date.now()
  if (cachedDirs && now - lastCheckMs < CACHE_TTL_MS) return cachedDirs

  lastCheckMs = now
  let mtime = 0
  try { mtime += statSync(persistedFile()).mtimeMs } catch {}
  try { mtime += statSync(sessionFile()).mtimeMs } catch {}
  if (cachedDirs && mtime === cachedMtime) return cachedDirs
  cachedMtime = mtime
  cachedDirs = loadDirs()
  return cachedDirs
}

export function invalidateCache() {
  cachedDirs = undefined
  cachedMtime = 0
  lastCheckMs = 0
}

export function isChildOf(parent: string, child: string) {
  return child === parent || child.startsWith(parent + "/")
}

export function matchesDirs(dirs: Map<string, DirEntry>, filepath: string) {
  for (const entry of dirs.values()) {
    if (isChildOf(entry.path, filepath)) return true
  }
  return false
}

const PKG = "opencode-add-dir"
function configDir() {
  return join(
    process.env["XDG_CONFIG_HOME"] || join(process.env["HOME"] || "~", ".config"),
    "opencode",
  )
}

function stripJsonComments(text: string): string {
  let result = ""
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (escape) { result += ch; escape = false; continue }
    if (ch === "\\" && inString) { result += ch; escape = true; continue }
    if (ch === '"') { inString = !inString; result += ch; continue }
    if (inString) { result += ch; continue }
    if (ch === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue }
    if (ch === "/" && text[i + 1] === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue }
    result += ch
  }
  return result
}

// Share the startup marker across plugin instances and module reloads.
const SESSION_STARTUP = Symbol.for("opencode-add-dir.session-startup")
const processState = globalThis as typeof globalThis & { [SESSION_STARTUP]?: Set<string> }

export function initializeSessionDirs() {
  const initialized = processState[SESSION_STARTUP] ??= new Set<string>()
  const file = sessionFile()
  if (initialized.has(file)) return
  try { unlinkSync(file) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  initialized.add(file)
  invalidateCache()
}

function findTuiConfig(): string {
  for (const name of ["tui.jsonc", "tui.json"]) {
    const p = join(configDir(), name)
    if (existsSync(p)) return p
  }
  return join(configDir(), "tui.json")
}

export function ensureTuiConfig() {
  initializeSessionDirs()
  try {
    mkdirSync(configDir(), { recursive: true })

    const filePath = findTuiConfig()
    let config: Record<string, unknown> = {}

    if (existsSync(filePath)) {
      config = JSON.parse(stripJsonComments(readFileSync(filePath, "utf-8")))
    }

    const plugins = (config.plugin ?? []) as unknown[]
    const hasEntry = plugins.some((p) => {
      const name = Array.isArray(p) ? p[0] : p
      return name === PKG || (typeof name === "string" && name.startsWith(PKG + "@"))
    })

    if (hasEntry) return

    config.plugin = [...plugins, PKG]
    writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n")
  } catch {
    // Non-critical
  }
}
