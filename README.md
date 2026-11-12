# kimi-agent-desktop

**Desktop computer use for [Kimi Code](https://www.kimi.com/code) — macOS, Windows and Linux — powered by vercel-labs' own MCP server: every `agent-desktop` CLI command becomes a `desktop_*` MCP tool with a generated schema.**

A Kimi Code / Kimi Code Desktop plugin that runs [`agent-desktop mcp`](https://github.com/vercel-labs/agent-desktop) — the MCP server built into the agent-desktop CLI itself (since v1.2.0). The tool catalog is derived from the CLI, so it always matches the installed version: new upstream commands appear without a plugin update. Intended as a drop-in replacement for the bundled Kimi Computer Use (kimi-cu) plugin.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: macOS / Windows / Linux](https://img.shields.io/badge/Platform-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-black.svg)]()
[![Kimi Code](https://img.shields.io/badge/Kimi%20Code-plugin-orange.svg)](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html)

## Why the vendor server (v0.2.0)

Up to v0.1.x this plugin shipped a hand-written wrapper (21 curated tools over an ad-hoc JSON-RPC bridge). agent-desktop v1.2.0 added `agent-desktop mcp`: the CLI itself now serves MCP over stdio, with each leaf command exposed as a tool and argument schemas generated from the CLI definitions — the vendor keeps it in lockstep with the CLI, covers Windows and Linux, and adds tools (sandbox VMs, notifications, window management, hover, double-click, …) a wrapper can't track. This plugin now launches that server directly and keeps the curated part where it belongs: the skill's loop, boundaries, and the Kimi-specific permission notes.

## Install

One-time CLI setup:

```sh
./bin/setup.sh   # installs agent-desktop (>= 1.2.0) via npm or brew, opens the required settings panes
```

Then grant **Accessibility** and **Screen Recording** to the **Kimi Code** app (System Settings → Privacy & Security — the rights attach to Kimi Code because its process runs the CLI), and in any Kimi Code session:

```
/plugins install https://github.com/mnshkv/kimi-agent-desktop
```

Then `/plugins reload` (or start a new session). Verify with `agent-desktop status`.

## How it works

```
Kimi Code ──MCP (stdio)──▶ agent-desktop mcp ──▶ agent-desktop CLI
                                                      └─▶ OS Accessibility APIs
```

- Tools: `desktop_snapshot`, `desktop_click`, `desktop_type`, `desktop_wait`, `desktop_screenshot`, `desktop_sandbox_*`, … — the live catalog comes from the server (`tools/list`).
- Headless by default: no cursor movement, no focus stealing — you can keep using your Mac while the agent works. Physical input (drag, hover, mouse commands) requires the server-level `--headed` flag: add `"--headed"` to the `args` in `kimi.plugin.json`.
- Screenshots come back as MCP image content (handled by the vendor server).

## Migrating from Kimi Computer Use (kimi-cu)

- The wrapper's curated names are gone: `get_app_state` is `desktop_snapshot`, `type_text` is `desktop_type`, `press_key` is `desktop_press`, … The skill documents the mapping (`agent-desktop snapshot …` = `desktop_snapshot {"app": …}`).
- **Still not carried over:** text-range selection (use `desktop_set_value`), rich markdown/HTML paste.
- `drag` and other physical actions are available with the headed flag (see above); headless ref actions cover most flows.

## Permissions model

Unlike kimi-cu (which kept its grants in a private launchd service), rights attach to **Kimi Code.app**. Updating or re-signing the app may reset the grants — `desktop_status` shows this, and re-granting restores everything.

## Related

- [kimi-xcode-plugin](https://github.com/mnshkv/kimi-xcode-plugin) — Xcode integration for Kimi Code via Xcode's own MCP server
- [kimi-android-studio-plugin](https://github.com/mnshkv/kimi-android-studio-plugin) — Android devices, emulators, and gradle over MCP
- [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) — the CLI and its built-in MCP server (Apache-2.0)
