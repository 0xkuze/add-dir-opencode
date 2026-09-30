import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

/** Keep plugin initialization and persistence away from the user's state. */
export function createTestEnvironment(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const previousData = process.env["XDG_DATA_HOME"]
  const previousConfig = process.env["XDG_CONFIG_HOME"]
  process.env["XDG_DATA_HOME"] = join(root, "data")
  process.env["XDG_CONFIG_HOME"] = join(root, "config")

  return {
    root,
    cleanup() {
      if (previousData === undefined) delete process.env["XDG_DATA_HOME"]
      else process.env["XDG_DATA_HOME"] = previousData
      if (previousConfig === undefined) delete process.env["XDG_CONFIG_HOME"]
      else process.env["XDG_CONFIG_HOME"] = previousConfig
      rmSync(root, { recursive: true, force: true })
    },
  }
}
