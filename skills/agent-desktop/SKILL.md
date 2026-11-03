---
name: agent-desktop
description: |
  Operate desktop applications on macOS through the native accessibility tree via the agent-desktop MCP tools
  (this plugin wraps the vercel-labs agent-desktop CLI). Use when the user asks to see or act on a desktop GUI:
  click buttons, fill forms, read UI state, navigate menus, toggle checkboxes, scroll, type, press shortcuts,
  take screenshots, use the clipboard, launch or close apps. Управление приложениями на Mac: «нажми», «заполни»,
  «открой», «посмотри, что на экране», «computer use», «управляй приложением».
---

# agent-desktop — macOS GUI automation

Observe with `get_app_state` / `find`, act on a **ref**, observe again to verify. Every tool maps to one
`agent-desktop` CLI call and answers with a JSON envelope; actions add `data.disposition`, errors carry
`error.code` + `error.disposition`. The loop lives in you.

## Boundaries

- Everything is **headless**: no real cursor movement, no focus stealing, no window raising. The one physical
  tool is `drag` (needs `headed:true`) — use only when the task explicitly requires cursor-level interaction.
- Do not work around failures with AppleScript/cliclick/synthetic events.
- Sending, submitting, deleting, paying: only inside the scope the user explicitly authorized. Don't re-confirm
  an authorized action, do ask when required information is missing.
- Snapshots and screenshots contain private desktop content. Never send them to public logs or uploads.

## The loop

1. Target unclear → `list_apps` (running apps; use `launch` for an app that is closed), then `list_windows`
   when the app has several windows or same-named instances.
2. Observe with `get_app_state` (default `mode:"full"` = tree with refs + screenshot). Dense app:
   `skeleton:true` first, then `get_app_state` again with `root_ref` to drill into one region.
   A menu, sheet or alert opened by an action is its own **surface**: pass `surface:"menu"` (etc.) to observe it.
3. Act on a ref from that observation: `click`, `type_text`, `set_value`, `select_option`, `toggle`, `scroll`,
   `press_key`.
4. Verify the actual effect with a fresh observation. Delivered ≠ effective; check the UI, not the tool result.

## Refs

- Refs are qualified (`@<snapshot_id>:e<N>`) and belong to **one snapshot**. After any UI change, re-observe the
  affected region; `STALE_REF` / `SNAPSHOT_NOT_FOUND` mean: take a new snapshot, don't retry the old ref.
- `AMBIGUOUS_TARGET`: several windows matched — pass `window_id` from `list_windows`.
- `list_windows` truncates `app_name`; identify a window by its `id`, not by the truncated name
  (or resolve the full name from `list_apps` by `pid`).
- Re-drilling with `root_ref` can fail with `APP_NOT_FOUND` on apps whose localized name exceeds 16 characters
  (the CLI stores the truncated name) — an upstream CLI bug; in that case re-observe the whole window without `root_ref`.
- Only addressable elements get refs; static text does not. Empty trees can mean self-drawn UI — use the
  screenshot and coordinates (`drag` with `from_xy`/`to_xy`) instead of assuming a broken setup.

## Delivery and retry

- Retry an action **only** when `disposition.retry` is `"safe"` (only `not_delivered` is safe). Any other
  delivery may have landed: repeating can double-click, double-type or flip a `toggle` back.
- Otherwise read live state (`get` via a fresh `get_app_state` with `root_ref`) and decide from that.
- `PERM_DENIED`: run `status`; grant Kimi Code Accessibility / Screen Recording in System Settings, then retry.
- Chromium/Electron apps can render the tree slowly: raise `timeout_ms` (e.g. 10000) on `get_app_state`.

## Input and editing

- Whole-value writes: `set_value`. Inserting/appending text: `type_text` (appends; `replace:true` sets the
  whole value atomically). Dropdowns: `select_option` (there is **no** text-range selection in this toolset).
- Both target a ref directly and need no caret click. Semantic clicks work on AXPress elements (buttons,
  links, menu items); text areas may refuse with `POLICY_DENIED` (fail-closed headless) — expected; go
  straight to type_text instead of retrying clicks.
- Checkboxes/switches: `toggle` — verify the flipped state afterwards.
- Key combos: `press_key` with `app`/`window_id` reaches the app **without focusing it**; without a target it
  goes to system focus. `force:true` overrides dangerous-shortcut refusal.

## Waiting and batching

- Use `wait` instead of fixed sleeps: element + predicate (`exists/enabled/visible/actionable/value`), text in
  tree, window title, lifecycle `event`, menu open/closed. A fixed `ms` wait is a race.
- `batch` runs several already-observed steps in one call. Never pre-write steps that depend on UI you have not
  seen yet; the batch is not atomic (`stop_on_error` halts on first failure, delivered steps stay delivered).

## Tool ↔ CLI map

status · list_apps · list_windows · get_app_state(snapshot+screenshot) · find · click(1/2/3, right) ·
type_text(type/set-value) · set_value · press_key · scroll · select_option · toggle · drag(headed) ·
screenshot · clipboard_get/set/clear · wait · batch · launch · close_app.

Screenshots come back as image blocks downscaled to 2048 px (`full_resolution:true` keeps raw).
