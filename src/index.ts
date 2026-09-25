import { AddDirServerV2 } from "./v2-plugin.js"
import { AddDirPlugin } from "./plugin.js"

/**
 * Dual V1/V2 entrypoint.
 *
 * - OpenCode 2 reads `id` + `setup()` and ignores `server()`.
 * - OpenCode 1 (>= 1.18.29) calls `server()` and ignores `setup()`.
 *
 * See https://opencode.ai/v2/docs/build/plugins/migrate-v1#support-v1
 */
export default {
  ...AddDirServerV2,
  server: AddDirPlugin,
}
