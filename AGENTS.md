# AGENTS.md

Guidance for AI agents working in this repository.

## What this repo is

`opencode-add-dir` — an OpenCode plugin that adds Claude Code-style `/add-dir`
functionality: users can add external working directories to their session and
the plugin auto-approves `external_directory` permission checks for those
directories, plus injects them into the system prompt.

- npm package: `opencode-add-dir`, MIT, published via semantic-release on push to `main`.
- Runtime: Bun (build, test, package manager). TypeScript, ESM only.
- Upstream: `github.com/0xkuze/add-dir-opencode` (npm `opencode-add-dir`).

## Dual V1/V2 OpenCode support (important)

The package deliberately ships **both** OpenCode 1 and OpenCode 2 plugin
implementations from one set of entrypoints, following the dual-export pattern
in https://opencode.ai/v2/docs/build/plugins/migrate-v1#support-v1:

- **OpenCode 2** reads `id` + `setup()` on the default export and ignores
  everything else. It also auto-loads the `./tui` export beside the main entry.
- **OpenCode 1 (>= 1.18.29)** calls `server()` (server entry) and `tui()`
  (TUI entry) and ignores `setup()`. The V1 object entrypoint shape is why the
  dev dependency on `@opencode-ai/plugin` should stay on a recent 1.x version.

Do not delete the V1 code paths when touching V2 code (or vice versa) unless
explicitly asked — backwards compatibility is intentional. Keep both sides
working: `test/plugin.test.ts` covers V1, `test/v2-plugin.test.ts` covers V2,
and `test/package.test.ts` verifies the built artifacts export both shapes.

### Entry points

| File | Role |
|---|---|
| `src/index.ts` | Server entry. Default export: `{ ...AddDirServerV2, server: AddDirPlugin }` |
| `src/v2-plugin.ts` | V2 server plugin: `Plugin.define({ id, setup })` from `@opencode/plugin` |
| `src/plugin.ts` | V1 server plugin (`Plugin` from `@opencode-ai/plugin`) — `config`, `tool.execute.before`, `event`, `experimental.chat.system.transform` hooks |
| `src/tui-plugin.tsx` | V1 TUI plugin (JSX, `@opencode-ai/plugin/tui` + `@opentui/solid`) + dual default export `{ ...AddDirTuiV2, tui }` |
| `src/v2-tui.ts` | V2 CLI plugin from `@opencode/plugin/tui`: keymap-layer slash commands (registered from an `app` slot render — see the gotcha below), promise-based dialogs, and a select-dialog directory browser |
| `src/tui-state.ts` | Shared TUI state helpers (paths, validate, add/remove) used by both TUI implementations |
| `src/state.ts` | Shared server state: `directories.json` / `session-dirs.json` persistence, mtime cache, path matching, V1 `tui.json` self-registration (`ensureTuiConfig`) |
| `src/permissions.ts` | V1 permission hacks (session grant prompt, `permission.asked` auto-approve) |
| `src/context.ts` | System-prompt injection (`collectAgentContext`), used by both V1 and V2 |

### V1 vs V2 permission mechanics (why the code looks so different)

- **V1** needed three cooperating layers: a `config` hook injecting
  `permission.external_directory["<dir>/*"] = "allow"` rules, a
  `tool.execute.before` hook sending a no-reply grant prompt with
  `tools: { external_directory: true }`, and an `event` hook replying `always`
  to matching `permission.asked` events.
- **V2** funnels every `external_directory` check through one
  `ctx.permission.hook("evaluate")` (runs before a prompt is published), so
  allowing there covers read/edit/glob/grep/shell uniformly. System prompt
  injection is `ctx.session.hook("context")` pushing text parts into
  `event.system`.
- Explicit configured `deny` rules always win in V2 — the evaluate hook only
  turns `ask` into `allow`.
- V2 has **no native equivalent** of this plugin (verified against the
  installed binary): the only built-in mechanism is static
  `permissions` entries in `opencode.json`. Interactive add/list/remove,
  session-scoped vs persistent directories, system-prompt injection of the
  directory list, and `OPENCODE_ADDDIR_INJECT_CONTEXT` file injection are all
  plugin value. Keep this in mind before "simplifying" the plugin away.
- V2 CLI `/add-dir` sends no session message on purpose: the server plugin
  injects the directory list into the system prompt on every model request,
  which notifies the agent on its next turn without creating a request or a
  visible message (an earlier synthetic-message approach steered the session
  invisibly — removed).
- V2 CLI plugin gotcha: `context.keymap` is backed by a Solid context provider
  that only exists inside the mounted component tree. Calling
  `context.keymap.layer(...)` directly in `setup()` fails at TUI load with
  `"Keymap.Provider is missing"` (visible as `role=cli` warnings in
  `~/.local/share/opencode/log/opencode.log`). Global layers must be registered
  from inside a slot render — `src/v2-tui.ts` claims the `app` slot and
  registers the layer there (it renders null and owns only the keymap layer).

## Commands

```bash
bun install
bun test            # all tests (includes a full build in package.test.ts)
bun run typecheck   # tsc --project tsconfig.check.json (covers src, scripts, test)
bun run build       # clean dist, build server (node target) + TUI (bun target, solid JSX), emit .d.ts
bun run deploy      # server + TUI build without .d.ts emit (local use)
```

- The TUI build (`scripts/build-tui.ts`) needs the `@opentui/solid` bun plugin
  for JSX compilation of `src/tui-plugin.tsx`. Both plugin packages
  (`@opencode-ai/plugin`, `@opencode/plugin`) and their `/tui` subpaths are
  externals in both builds — never bundle them.
- `package.json` keeps the V1 `oc-plugin: ["server", "tui"]` manifest for
  OpenCode 1; OpenCode 2 only needs the `.` and `./tui` exports.

## Testing a local checkout as a plugin (instead of the npm package)

- Build first: `bun run build`. The `exports` map points at `dist/index.js`
  and `dist/tui.js`, and OpenCode resolves a plain directory entry without
  walking the repo root's `package.json` — point the config at the **`dist/`
  directory**, not the repo root.
- OpenCode 2: add the dist path to `plugins` in
  `~/.config/opencode/opencode.json` (or a project `opencode.json`) —
  `"plugins": ["/abs/path/to/add-dir-opencode/dist"]`. V2 loads both the
  server and TUI parts from that one entry. After changing anything in
  `dist/`, `opencode service restart` is the reliable reload path (a TUI-only
  restart may not be enough when the service still holds the plugin's last
  registration state).
- OpenCode 1: add the same path to `plugin` in both `opencode.json` and
  `~/.config/opencode/tui.json`.
- Check loading in `~/.local/share/opencode/log/opencode.log`: `role=server`
  lines show the server plugin, `role=cli` lines show the TUI plugin — a
  `plugin operation failed` warning there means the TUI entry failed to load.

## State files (runtime, not in repo)

- `$XDG_DATA_HOME|~/.local/share/opencode/add-dir/directories.json` — persisted dirs.
- `.../session-dirs.json` — session-only dirs; cleared once per server process and data directory. A process-wide startup marker preserves active dirs across plugin instances and module reloads.
- `OPENCODE_ADDDIR_INJECT_CONTEXT=1` also injects `AGENTS.md`, `CLAUDE.md`,
  `.agents/AGENTS.md` from each added dir into the system prompt.

## Conventions / gotchas

- Do not commit or push; the maintainer reviews and releases via semantic-release
  (conventional commits matter — `feat:`, `fix:`, etc. drive the version).
- CI (`.github/workflows/ci.yml`): `bun install --frozen-lockfile`, typecheck,
  test, build. If you touch dependencies, leave `bun.lock` consistent.
- Keep the built artifacts free of `react/jsx`/`jsx-dev-runtime` references and
  never publish `.tsx`/`src/`/`scripts/` files (asserted by `test/package.test.ts`).
- V2 plugin/API docs: https://opencode.ai/v2/docs/build/plugins (source of truth;
  V1 docs at https://opencode.ai/docs/ only for the legacy code paths).
