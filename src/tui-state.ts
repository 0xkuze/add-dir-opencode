import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "fs"
import { join, resolve } from "path"

export const STATE_DIR = join(
  process.env["XDG_DATA_HOME"] || join(process.env["HOME"] || "~", ".local", "share"),
  "opencode",
  "add-dir",
)
export const PERSISTED_FILE = join(STATE_DIR, "directories.json")
export const SESSION_FILE = join(STATE_DIR, "session-dirs.json")

export function readJsonArray(file: string): string[] {
  try { return JSON.parse(readFileSync(file, "utf-8")) } catch { return [] }
}

export function writeJsonArray(file: string, items: string[]) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(file, JSON.stringify(items, null, 2))
}

export function allDirs(): string[] {
  return [...new Set([...readJsonArray(PERSISTED_FILE), ...readJsonArray(SESSION_FILE)])]
}

export function resolvePath(input: string) {
  const p = input.trim()
  return resolve(p.startsWith("~/") ? (process.env["HOME"] || "~") + p.slice(1) : p)
}

export function validate(input: string): string | undefined {
  if (!input.trim()) return "Path is required."
  const abs = resolvePath(input)
  try { if (!statSync(abs).isDirectory()) return `Not a directory: ${abs}` }
  catch { return `Not found: ${abs}` }
  if (allDirs().includes(abs)) return `Already added: ${abs}`
}

export function addDir(abs: string, persist: boolean) {
  const file = persist ? PERSISTED_FILE : SESSION_FILE
  const dirs = readJsonArray(file)
  if (!dirs.includes(abs)) writeJsonArray(file, [...dirs, abs])
}

export function removeDir(path: string) {
  for (const file of [PERSISTED_FILE, SESSION_FILE]) {
    const dirs = readJsonArray(file)
    if (dirs.includes(path)) writeJsonArray(file, dirs.filter((d) => d !== path))
  }
}
