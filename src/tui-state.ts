import { statSync } from "fs"
import { resolve } from "path"
import { expandHome, persistedFile, sessionFile, readJsonArray, writeJsonArray } from "./state.js"

export function allDirs(): string[] {
  return [...new Set([...readJsonArray(persistedFile()), ...readJsonArray(sessionFile())])]
}

export function resolvePath(input: string) {
  const p = input.trim()
  return resolve(expandHome(p))
}

export function validate(input: string): string | undefined {
  if (!input.trim()) return "Path is required."
  const abs = resolvePath(input)
  try { if (!statSync(abs).isDirectory()) return `Not a directory: ${abs}` }
  catch { return `Not found: ${abs}` }
  if (allDirs().includes(abs)) return `Already added: ${abs}`
}

export function addDir(abs: string, persist: boolean) {
  const file = persist ? persistedFile() : sessionFile()
  const dirs = readJsonArray(file)
  if (!dirs.includes(abs)) writeJsonArray(file, [...dirs, abs])
}

export function removeDir(path: string) {
  for (const file of [persistedFile(), sessionFile()]) {
    const dirs = readJsonArray(file)
    if (dirs.includes(path)) writeJsonArray(file, dirs.filter((d) => d !== path))
  }
}
