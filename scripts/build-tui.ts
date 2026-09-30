import { mkdirSync } from "fs"
import { join } from "path"

import solidPlugin from "@opentui/solid/bun-plugin"

const outdir = join(import.meta.dir, "..", "dist")
const target = join(outdir, "tui.js")
mkdirSync(outdir, { recursive: true })

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "src", "tui-plugin.tsx")],
  outdir,
  target: "bun",
  format: "esm",
  naming: { entry: "tui.js" },
  plugins: [solidPlugin],
  external: [
    "@opencode-ai/plugin",
    "@opencode-ai/plugin/tui",
    "@opencode/plugin",
    "@opencode/plugin/tui",
    "@opentui/core",
    "@opentui/solid",
    "solid-js",
  ],
})

if (!result.success) {
  console.error("TUI build failed:")
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const entries = result.outputs.filter((output) => output.kind === "entry-point")

if (entries.length !== 1 || entries[0]?.path !== target) {
  console.error("TUI build produced an unexpected entry:", entries.map((entry) => entry.path))
  process.exit(1)
}

console.log("Built", target)
