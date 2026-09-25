import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { listSubdirs } from "../src/v2-tui"

const TMP = join(tmpdir(), "add-dir-tui-test")

beforeEach(() => mkdirSync(TMP, { recursive: true }))
afterEach(() => rmSync(TMP, { recursive: true, force: true }))

describe("listSubdirs", () => {
  test("lists non-hidden subdirectories sorted by name", () => {
    mkdirSync(join(TMP, "b-dir"))
    mkdirSync(join(TMP, "a-dir"))
    writeFileSync(join(TMP, "file.txt"), "not a dir")
    expect(listSubdirs(TMP)).toEqual([
      join(TMP, "a-dir"),
      join(TMP, "b-dir"),
    ])
  })

  test("skips hidden directories", () => {
    mkdirSync(join(TMP, ".git"))
    mkdirSync(join(TMP, "visible"))
    expect(listSubdirs(TMP)).toEqual([join(TMP, "visible")])
  })

  test("returns empty for a missing directory", () => {
    expect(listSubdirs(join(TMP, "missing"))).toEqual([])
  })
})
