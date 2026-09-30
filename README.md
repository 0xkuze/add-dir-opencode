# /add-dir for OpenCode

Add working directories to your [OpenCode](https://opencode.ai) session — inspired by Claude Code's [`/add-dir`](https://docs.anthropic.com/en/docs/claude-code/cli-usage#add-dir) command.

When you need an agent to read, edit, or search files outside the current project, this plugin grants access without permission popups.
![add_dir_2](https://github.com/user-attachments/assets/9b048406-0ab0-4510-a424-f5e83923db70)

## Quick Start

```bash
opencode plugin add opencode-add-dir
```

Restart OpenCode (or run `opencode service restart`).

The plugin supports both OpenCode 2 and OpenCode 1 (>= 1.18.29) from the same package: OpenCode 2 loads the V2 `setup()` entrypoints, OpenCode 1 calls the V1 `server()` / `tui()` functions. On OpenCode 1 the plugin also auto-registers itself in your `tui.json`.

<details>
<summary>Alternative: local development</summary>

```bash
git clone https://github.com/kuzeofficial/add-dir-opencode.git
cd add-dir-opencode
bun install && bun run build
```

Add the built `dist/` directory to your config — OpenCode 2 loads both the server and TUI parts from one entry:

```jsonc
// ~/.config/opencode/opencode.json (OpenCode 2)
{
  "plugins": ["/path/to/add-dir-opencode/dist"]
}
```

On OpenCode 1, configure the server and TUI entries in their respective files:

```jsonc
// ~/.config/opencode/opencode.json (OpenCode 1)
{ "plugin": ["/path/to/add-dir-opencode/dist/index.js"] }

// ~/.config/opencode/tui.json (OpenCode 1)
{ "plugin": ["/path/to/add-dir-opencode/dist/tui.js"] }
```

The server plugin can also register the TUI entry automatically when OpenCode 1 starts. Building with `bun run build` or `bun run deploy` alone does not update your configuration.

</details>

## Commands

All commands are interactive dialogs — type the command and select from autocomplete.

| Command | Dialog | Description |
|---------|--------|-------------|
| `/add-dir` (OpenCode 2) | Directory browser | Browse from the current directory's parent: descend into subdirectories, go up with `..`, confirm with "✓ Add this directory", or pick "Type a path instead…". Then choose "This session only" or "Remember across sessions". |
| `/add-dir` (OpenCode 1) | Text input + remember checkbox | Enter a directory path. Toggle "Remember across sessions" with Tab to persist it across restarts; leave it unchecked for this session only. |
| `/list-dir` | Alert | Shows all added directories. |
| `/remove-dir` | Select list + confirm | Pick a directory to remove, then confirm. |

## How It Works

The plugin has two parts: a **CLI/TUI plugin** for the interactive dialogs and a **server plugin** for silent permission handling. Each part ships a V2 implementation (OpenCode 2, `@opencode/plugin`) and a V1 implementation (OpenCode 1, `@opencode-ai/plugin`) behind one package export.

### TUI Plugin

Handles all three slash commands via dialogs. Directories are stored in two files under `~/.local/share/opencode/add-dir/`:

- **`directories.json`** — Persisted dirs, survive restarts.
- **`session-dirs.json`** — Session-only dirs, cleared once when the server process starts. Loading another plugin instance or reloading the plugin preserves active directories.

Which file gets written depends on the "Remember across sessions" choice in `/add-dir`.

> Respects `XDG_DATA_HOME` if set.

### Server Plugin (OpenCode 2)

Runs in the background — no commands, only hooks registered through the V2 plugin context:

| Hook | What it does |
|------|-------------|
| `ctx.permission.hook("evaluate")` | When any tool needs `external_directory` approval for a path under an added directory, resolves the check to `allow` before a permission prompt is ever shown. Covers `read`/`edit`/`glob`/`grep` and shell working directories uniformly. |
| `ctx.session.hook("context")` | Injects added directory paths into the system prompt so the LLM knows about them. |

An explicit `deny` in your own permission rules always wins — the hook only turns `ask` into `allow`, never overrides a configured denial.

### Server Plugin (OpenCode 1)

The legacy implementation keeps the original three cooperating layers: the `config` hook injects `external_directory: "allow"` rules, `tool.execute.before` pre-authorizes sessions when file tools target an added directory, and the `event` hook auto-approves `permission.asked` requests that match.

### Context Injection

By default the system prompt only gets the list of added directories. If you set:

```bash
export OPENCODE_ADDDIR_INJECT_CONTEXT=1
```

The plugin will also read and inject `AGENTS.md`, `CLAUDE.md`, and `.agents/AGENTS.md` from each added directory into the system prompt — useful when working across projects that have their own agent instructions.

## Development

```bash
bun install
bun test           # Run tests
bun run typecheck  # Type check
bun run build      # Build npm package
bun run deploy     # Build server + TUI locally
```

### Project Structure

```
src/
├── index.ts          # Server entry: dual V1 (server()) + V2 (setup()) export
├── v2-plugin.ts      # V2 server plugin (permission evaluate + context hooks)
├── plugin.ts         # V1 server hooks (permissions, context injection)
├── tui-plugin.tsx    # V1 TUI plugin (dialogs for add/list/remove) + dual export
├── v2-tui.ts         # V2 CLI plugin (keymap commands + promise dialogs)
├── tui-state.ts      # Shared TUI state helpers (add/remove/validate dirs)
├── state.ts          # Persistence, caching, path utils, tui.json auto-config
├── permissions.ts    # V1 session grants + auto-approve
├── context.ts        # System prompt injection
└── types.ts          # Shared V1 type definitions
```

## License

[MIT](LICENSE)
