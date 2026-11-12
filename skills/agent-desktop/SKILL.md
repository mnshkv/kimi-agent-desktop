---
name: agent-desktop
description: |
  Operate desktop applications on macOS, Windows and Linux through native accessibility trees via the agent-desktop
  MCP tools (served by `agent-desktop mcp` from vercel-labs/agent-desktop). Use when the user asks to see or act on a
  desktop GUI: click buttons, fill forms, read UI state, navigate menus, toggle checkboxes, scroll, drag, type, press
  shortcuts, take screenshots, use the clipboard, manage windows, read notifications, launch or close apps, run a
  sandboxed desktop VM. Управление приложениями: «нажми», «заполни», «открой», «посмотри, что на экране»,
  «computer use», «управляй приложением».
---

# agent-desktop — desktop GUI automation (upstream MCP server)

Since v0.2.0 this plugin runs vercel-labs' own MCP server (`agent-desktop mcp`): **every CLI command of
agent-desktop is one `desktop_<command>` tool** with a generated schema — `desktop_snapshot`, `desktop_click`,
`desktop_type`, `desktop_wait`, `desktop_screenshot`, `desktop_sandbox_create`, … The catalog follows the
installed CLI automatically, so new upstream commands appear here without plugin updates. This skill carries
the loop and the plugin's boundaries; OS specifics load via `desktop_skills_get {"name": "platform"}`,
command references via `desktop_skills_get {"name": "desktop", "reference": "…"}`.

## Boundaries (this plugin)

- As shipped, the server runs **headless**: no real cursor movement, no focus stealing, no window raising.
  Physical input (drag, hover, mouse commands, double/triple-click, raw coordinates) needs the server-level
  `--headed` flag — see below.
- Do not work around failures with AppleScript/cliclick/synthetic events.
- Sending, submitting, deleting, paying: only inside the scope the user explicitly authorized. Don't re-confirm
  an authorized action, do ask when required information is missing.
- Snapshots and screenshots contain private desktop content. Never send them to public logs or uploads.

## First run

1. `desktop_status` — platform, permissions, `supported_surfaces`.
2. `desktop_skills_get {"name": "platform"}` — what differs on this OS (Windows/Linux twin rules, PowerShell forms).
3. Tools map 1:1 to CLI commands: `agent-desktop snapshot --app Finder` is
   `desktop_snapshot {"app": "Finder"}`. Every CLI flag becomes an argument with the same meaning; exact
   names come from the tool's input schema (it replaces `--help`). Refs (`@s8f3k2p9:e1`) are plain strings.

## The loop

```
desktop_snapshot {"app": "Notes", ...}     # map the app (skeleton/depth flags trim dense trees)
desktop_snapshot {"root": "@s8f3k2p9:e3"}  # drill into one region of the same snapshot
desktop_click  {"ref": "@s8f3k2p9:e12"}    # act on a qualified ref
desktop_snapshot {"root": "@s8f3k2p9:e3"}  # verify: re-read the same region
```

Observe, act, observe again — the loop lives in you. `find` when you know the role or exact name; otherwise
map first, drill into one region. An action that opens a menu, sheet or alert lists it in `data.surfaces` —
target that overlay next. After an async step use `desktop_wait`; a fixed sleep is a race.

## Refs

- Refs are qualified (`@<snapshot_id>:e<N>`) and belong to one snapshot. After any UI change, re-observe the
  affected region; `STALE_REF` / `SNAPSHOT_NOT_FOUND` mean: snapshot again, don't retry the old ref.
- `AMBIGUOUS_TARGET` (`identity_not_unique`): the ref was not proven unique (identical twin, or the window
  could not be read whole in time — retake with a larger timeout). Re-snapshotting identical twins gives the
  same refusal; act on a control unique in the window, or use an explicit coordinate click (needs headed).
- Only addressable elements get refs; static text and inert containers do not.
- A `root` drill replaces refs inside the drilled subtree; refs outside it stay valid.

## Delivery and retry

- Every action reports `data.disposition` (errors: `error.disposition`) with `delivery` and `retry`.
- Retry or substitute an action **only** when `disposition.retry` is `"safe"` — only `not_delivered` is safe.
  Any other delivery may have landed: repeating can double-click, double-type or flip a toggle back.
- Otherwise read live state (`desktop_get`, `desktop_is`, fresh `desktop_snapshot`) and decide from that.
- `PERM_DENIED`: run `desktop_status`; grant Kimi Code Accessibility / Screen Recording in System Settings.
- Chromium/Electron apps can render the tree slowly: raise the snapshot timeout.

## Headless vs headed

The server fixes its global flags (`--session`, `--agent-id`, `--headed`, `--wait-for`, `--trace`) at startup;
they cannot be passed per call. As shipped in this plugin, it runs **without** `--headed`: ref actions
(click, type, set-value, select, toggle, scroll, press) deliver through semantic accessibility calls. To enable
physical input, add `"--headed"` to the `args` of the `mcpServers` entry in `kimi.plugin.json` and reload the
plugin. Never switch to headed mode to recover from a headless failure.

## Tool groups (the live list comes from the server)

Observation `desktop_status · snapshot · find · get · is · screenshot · list_surfaces · list_windows ·
list_apps · list_displays` — Interaction `click (+ right/double/triple) · type · set_value · select · check ·
uncheck · toggle · scroll · scroll_to · press · combo · drag · hover · mouse_* · focus` — System
`clipboard_get/set/clear · launch · close_app · focus_window · move/resize_window · maximize · minimize ·
restore · wait · batch · notifications_* · cursor_overlay · open_system_surface · session · permissions ·
skills · trace` — Sandboxes `sandbox install/create/start/stop/rm/list/exec` (isolated macOS VM; `exec` returns
the guest's own stdout).

Based on the agent-desktop skill (vercel-labs/agent-desktop, Apache-2.0), adapted for the MCP tool surface;
boundaries section by this plugin.
