# kimi-agent-desktop

**macOS computer use for [Kimi Code](https://www.kimi.com/code): accessibility-tree snapshots, headless clicks, typing, screenshots, clipboard, and batch sequences — 21 MCP tools, zero npm dependencies.**

A Kimi Code / Kimi Code Desktop plugin wrapping the open-source [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) CLI. It lets the agent observe and operate any macOS app — without moving the user's cursor or stealing focus. Intended as a drop-in replacement for the bundled Kimi Computer Use (kimi-cu) plugin.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: macOS](https://img.shields.io/badge/Platform-macOS-black.svg)]()
[![Kimi Code](https://img.shields.io/badge/Kimi%20Code-plugin-orange.svg)](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html)

## Features

| Area | What the agent can do |
|---|---|
| Observation | Accessibility-tree snapshots with qualified refs, element search (`find`), window and app listing, screenshots as image content (2048px) |
| Interaction | Headless clicks, typing, `set_value`, key combos, scroll, option selection, checkbox toggles |
| Sequencing | `batch` command lists, `wait` for elements/text/windows/lifecycle events |
| Clipboard | Read, write, and clear — text and PNG images |
| Apps | Launch and gracefully quit apps |
| Physical input | `drag` (the only headed action: moves the real cursor, requires explicit `headed: true`) |

Every call is one `agent-desktop` process; the server returns its JSON envelope (`ok`/`data`/`error` with `code`, `disposition.retry`, `suggestion`) and never retries an action on its own.

## Install

One-time CLI setup:

```sh
./bin/setup.sh   # npm i -g agent-desktop, opens the required settings panes
```

Then grant **Accessibility** and **Screen Recording** to the **Kimi Code** app (System Settings → Privacy & Security — the rights attach to Kimi Code because its process runs the CLI), and in any Kimi Code session:

```
/plugins install https://github.com/mnshkv/kimi-agent-desktop
```

Then `/plugins reload` (or start a new session). Verify with:

```sh
node tests/probe.mjs   # protocol smoke test, no GUI interaction
```

## Tools (21)

`status` · `list_apps` · `list_windows` · `get_app_state` · `find` · `click` · `type_text` · `set_value` ·
`press_key` · `scroll` · `select_option` · `toggle` · `drag` · `screenshot` · `clipboard_get` ·
`clipboard_set` · `clipboard_clear` · `wait` · `batch` · `launch` · `close_app`

## How it works

```
Kimi Code ──MCP (stdio)──▶ bin/agent-desktop-mcp.mjs ──▶ agent-desktop CLI
                                                              └─▶ macOS Accessibility APIs
                                                                  (AX tree, headless events, screenshots)
```

Headless by default: no cursor movement, no focus stealing — you can keep using your Mac while the agent works.

## Migrating from Kimi Computer Use (kimi-cu)

- Tool names match where there is a counterpart; both plugins can stay enabled at once (the host namespaces tools).
- **Not carried over:** `select_text` (no text-range selection in the CLI — use `set_value`), the `js`/`js_reset` REPL (use `batch`), rich markdown/HTML paste, guarded `drag_paths`.
- `drag` is the only physical tool: the CLI delivers drags via headed mode, so it moves the real cursor by design.

## Permissions model

Unlike kimi-cu (which kept its grants in a private launchd service), rights here attach to **Kimi Code.app**. Updating or re-signing the app may reset the grants — the `status` tool shows this, and re-granting restores everything.

## Development

- `node tests/probe.mjs` — protocol smoke test; `tests/` also has click/mutate/live/e2e probes.
- CLI flags are pinned to agent-desktop **0.10.1**; when upgrading the CLI, re-check `agent-desktop <cmd> --help`.
- Design doc: `docs/superpowers/specs/2026-11-03-agent-desktop-plugin-design.md`.

## Related

- [kimi-xcode-plugin](https://github.com/mnshkv/kimi-xcode-plugin) — Xcode integration for Kimi Code via Xcode's own MCP server
- [kimi-android-studio-plugin](https://github.com/mnshkv/kimi-android-studio-plugin) — Android devices, emulators, and gradle over MCP

## License

MIT.
