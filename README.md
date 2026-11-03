# agent-desktop — плагин Kimi Code Desktop

**English.** A [Kimi Code Desktop](https://www.kimi.com) plugin for macOS computer use on top of the open-source
[vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) CLI: accessibility-tree snapshots with
qualified refs, headless clicks/typing/keys/scroll, screenshots as image content, clipboard, wait and batch —
21 MCP tools, zero npm dependencies. Intended as a drop-in replacement for the bundled kimi-cu plugin.

**Install:** Kimi Code Desktop → Plugins → install from GitHub → `https://github.com/mnshkv/kimi-agent-desktop`
(or install this folder as a local plugin). One-time setup: `npm i -g agent-desktop`, then grant **Accessibility**
and **Screen Recording** to the *Kimi Code* app (its process runs the CLI). Details below / in README (Russian).

Computer Use для macOS поверх открытого CLI [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop):
accessibility-дерево со refs, headless клики/ввод/клавиши/скролл, скриншоты как image content, clipboard,
wait и batch. Замена плагина kimi-cu: курсор не двигается, фокус не крадётся.

## Установка

1. Один раз: `./bin/setup.sh` — поставит CLI (`npm i -g agent-desktop`) и откроет нужные панели настроек.
2. Выдай приложению **Kimi Code** права **Accessibility** и **Screen Recording**
   (Системные настройки → Конфиденциальность и безопасность). Права держит Kimi Code.app, потому что именно
   его процесс запускает CLI.
3. Установи плагин в Kimi Code Desktop: из GitHub (`https://github.com/mnshkv/kimi-agent-desktop`) или как
   локальную папку, затем перезапусти сессию.
4. Проверка: `node tests/probe.mjs` — protocol smoke-тест без участия GUI.

## Инструменты (21)

`status` · `list_apps` · `list_windows` · `get_app_state` · `find` · `click` · `type_text` · `set_value` ·
`press_key` · `scroll` · `select_option` · `toggle` · `drag` · `screenshot` · `clipboard_get` ·
`clipboard_set` · `clipboard_clear` · `wait` · `batch` · `launch` · `close_app`

Каждый вызов = один процесс `agent-desktop`, ответ — его JSON-конверт (`ok`/`data`/`error` с
`code`, `disposition.retry`, `suggestion`). Сервер никогда не повторяет действия сам.

## Переход с kimi-cu

- Имена инструментов совпадают, где есть отображение; после приёмки отключи kimi-cu в настройках плагинов
  (оба могут быть включены одновременно — инструменты неймспейсируются хостом).
- **Не переносится:** `select_text` (в CLI нет выбора текстового диапазона; замена — `set_value`),
  JS-REPL `js`/`js_reset` (замена — `batch`), rich paste md/html, `drag_paths` с guard'ом реального курсора.
- `drag` — единственный физический инструмент: CLI доставляет drag только через headed-режим, поэтому
  `drag` требует явного `headed:true` и двигает реальный курсор.

## Известные отличия модели прав

KimiCU держала права в собственном launchd-сервисе; здесь права висят на Kimi Code.app. Обновление или
переподпись приложения может сбросить гранты — инструмент `status` это покажет, выдача прав повторно
восстанавливает работу.

## Разработка

- `node tests/probe.mjs` — protocol smoke-тест.
- Флаги CLI зафиксированы по версии **0.10.1**; при обновлении CLI сверяй `agent-desktop <cmd> --help`.
- Дизайн: `docs/superpowers/specs/2026-11-03-agent-desktop-plugin-design.md`.
