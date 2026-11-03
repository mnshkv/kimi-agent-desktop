# Дизайн: плагин `agent-desktop` для Kimi Code Desktop — замена kimi-cu

Дата: 2026-11-03
Статус: черновик на утверждении
Репозиторий: `~/Development/kimi-agent-desktop`

## 1. Замысел и почему

[vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) — открытый CLI (v0.10.1, протокол конвертов 2.4) для computer use на macOS/Windows/Linux: снапшот accessibility-дерева в JSON, где каждому интерактивному элементу присвоен квалифицированный ref (`@<snapshot_id>:e<N>`); агент действует по ref (click/type/set-value/press/scroll/drag, ~56 команд), затем снапшотит снова. Всё headless по умолчанию: без движения курсора и кражи фокуса. Каждый вызов — отдельный процесс, вывод — один JSON-конверт `{version, ok, command, data|error}`; ошибки несут `code`, `suggestion`, `disposition{delivery, retry}`.

Мы делаем **плагин Kimi Code Desktop**, который заменяет текущий плагин kimi-cu (проприетарный, macOS-only, держит права в отдельном KimiCU.app через launchd-сервис) на обёртку над agent-desktop. Установка упрощается до `npm i -g agent-desktop`; права Accessibility/Screen Recording выдаются самому приложению **Kimi Code.app** — проверено: CLI запускается из его процесса, TCC атрибутирует AX-вызовы ему.

## 2. Цели, не-цели, анти-цели

### Цели (v1)

- Полноценная замена kimi-cu на этой машине: наблюдение (AX-дерево + скриншот), клики, ввод текста, клавиши, скролл, set-value, select, toggle, drag, clipboard, ожидание, batch, launch/close — всё headless по умолчанию.
- UX-паритет с kimi-cu: именованные MCP-инструменты со схемами; скриншоты возвращаются как MCP `image content` (base64 PNG), попадая в контекст модели без промежуточных файлов.
- SKILL.md, обучающий циклу observe→act→verify, на базе собственной документации CLI (`agent-desktop skills get desktop` / `get platform`) — не изобретаем свою философию.
- Самодиагностика: инструмент `status` объединяет `agent-desktop status` + `permissions` (версия CLI, ОС, состояние прав с подсказками).

### Не-цели (v1)

- JS-REPL kimi-cu (`js`/`js_reset`) — эквивалента в CLI нет; покрывается `batch` для целевых, кодом-проверяемых последовательностей.
- `drag_paths` с real-cursor guard — у CLI drag этого guard нет.
- Rich paste (md/html) — только plain text и clipboard.
- Уведомления, управление окнами (move/resize/minimize/maximize), трей/dock/spotlight surfaces — CLI умеет, v1 не экспортирует.
- Windows/Linux как хост-платформы: CLI кроссплатформенный, но плагин верифицируется на macOS; в манифесте `platforms: ["macos"]`, расширение позже.
- Managed-дистрибуция (zip-url/github-install) — только локальная установка из этой папки.

### Анти-цели (провал, даже если «работает»)

- Движение реального курсора или кража фокуса без явного запроса: `--headed` не входит в v1-инструменты (единственное исключение — параметр `headed` у `drag`, см. §6), `press` без него не фокусирует окно.
- Слепые повторы действий: повтор только при `disposition.retry == "safe"` (только `not_delivered`); иначе — повторное наблюдение.
- Логирование или загрузка наружу приватного контента снапшотов/скриншотов.

## 3. Ограничения

- Хост: MCP-команда плагина — PATH-команда или `./`-путь, cwd = корень плагина (формат `kimi.plugin.json`, образец — установленный kimi-cu).
- Runtime: системный Node ≥ 18 (на машине v24.18.0). **Ноль npm-зависимостей**: сервер — hand-rolled JSON-RPC на встроенных модулях, папка плагина без `node_modules`.
- CLI `agent-desktop` должен быть на PATH — ставится setup-скриптом плагина.
- Права macOS: Accessibility + Screen Recording на Kimi Code.app. Переподпись/обновление приложения может потребовать повторной выдачи.
- Приватность: снапшоты, скриншоты и clipboard могут содержать личное — сервер ничего не пишет на диск и не логирует содержимое.

## 4. Подходы (рассмотрены)

- **A. MCP-сервер + скилл (выбран).** Тонкий stdio-сервер оборачивает CLI; паритет с заменяемым плагином, картинки в контексте, схемы валидируют аргументы. Минус — код на поддержку (~700 строк).
- **B. Skill-only.** Манифест + SKILL.md, агент гоняет CLI через Bash. Отклонён: скриншоты в два шага, нет схем и discoverability, JSON каждый раз разбирается вручную.
- **C. FFI (libagent_desktop_ffi).** Отклонён: несоразмерно, проблемы ABI/владения памятью.

## 5. Архитектура

```
kimi.plugin.json              манифест (§8)
bin/agent-desktop-mcp.mjs     MCP-сервер, ноль зависимостей
bin/setup.sh                  установка CLI + проверка прав
skills/agent-desktop/SKILL.md скилл (§7)
README.md                     установка и one-time шаги
docs/superpowers/specs/       этот документ
```

**Сервер.** stdio, newline-delimited JSON-RPC 2.0 (проверено на мосте kimi-cu: хост говорит `protocolVersion "2025-06-18"`). Handshake: `initialize` → ответ `{protocolVersion:"2025-06-18", capabilities:{tools:{}}, serverInfo:{name:"agent-desktop", version}}`; затем `notifications/initialized`; далее `tools/list`, `tools/call`, `ping`. Реализация ~300–400 строк на встроенных модулях Node.

**Вызов команды.** Каждый `tools/call` = spawn `agent-desktop <command> [flags]` с env-пасстроу; stdout парсится как один JSON-конверт (CLI гарантирует один конверт на вызов). Таймаут по умолчанию 60 с (у долгих инструментов параметр `timeout_ms`), по истечении — kill; stderr попадает в текст ошибки. CLI не найден на PATH → `isError:true` с инструкцией установки. Сервер **никогда не ретраит** сам: решение о повторе — за моделью, по `disposition.retry`.

**Возвращаемые значения.** Успех: `content:[{type:"text", text: <JSON конверта data>}]; изображения — доп. блок `{type:"image", data:<base64>, mimeType:"image/png"}`. Ошибка CLI: `isError:true`, текст с `code`, `disposition`, `suggestion`. Рефы не парсятся сервером — передаются как есть; `STALE_REF` / `AMBIGUOUS_TARGET` / `SNAPSHOT_NOT_FOUND` приходят от CLI, скилл учит переснапшотить.

## 6. Поверхность инструментов (v1)

Имена повторяют kimi-cu там, где есть отображение, — для лёгкой миграции привычек. Точные флаги каждого CLI-маппинга фиксируются из `agent-desktop <cmd> --help` на этапе реализации; расхождение семантики с таблицей ниже адаптируется внутри этих границ.

| Инструмент | CLI | Заметки |
|---|---|---|
| `status()` | `status` + `permissions` | bootstrap/doctor: версии, ОС, права + suggestion |
| `list_apps({running_only})` | `list-apps` | |
| `list_windows({app?, pid?})` | `list-windows` | |
| `get_app_state({app, window_id?, mode:"full"\|"ax"\|"image"="full", interactive_only?, skeleton?, compact?, root_ref?, max_depth?, include_bounds?, surface?, wait_for?, wait_timeout_ms?, timeout_ms?})` | `snapshot` (+`screenshot`) | `full` = дерево + скриншот; `ax` = только дерево; `image` = только скриншот. `root_ref` → `--root`; surface: menu/sheet/alert/… Скриншот ужимается до длинной грани 2048 px через системный `sips` (без npm-зависимостей), как в kimi-cu; параметр `full_resolution:true` возвращает raw base64 CLI |
| `find({app?, window_id?, role?, name?, text?, value?, exact?, root_ref?, first?, limit?, surface?})` | `find` | быстрый поиск по роли/имени без полного дерева |
| `click({ref, count:1\|2\|3, button:"left"\|"right"})` | `click` / `double-click` / `triple-click` / `right-click` | варианты — отдельные CLI-команды (таблица команд README); схема не обещает флагов, которых нет |
| `type_text({ref, text, replace?=false})` | `type` / `set-value` | CLI `type` только дописывает: `replace:true` реализуется как `set-value(text)` (атомарно, без дублирования), `replace:false` — как `type` (дописать) |
| `set_value({ref, value})` | `set-value` | |
| `press_key({combo, app?, window_id?})` | `press` | headless: `--app` шлёт клавиши процессу без фокуса |
| `scroll({ref?, …})` | `scroll` | флаги сверить с `--help` |
| `select_option({ref, value})` | `select` | CLI `select` выбирает опцию dropdown/списка — это НЕ аналог `select_text` kimi-cu; выбор текстового диапазона в CLI отсутствует → в v1 не переносится (замена: `set_value`/`clear`+`type`); задача помечена как известная деградация |
| `toggle({ref, …})` | `toggle` / `check` / `uncheck` / `expand` / `collapse` | |
| `drag({from_ref, to_ref, headed?=false})` | `drag` | если CLI требует `--headed` — вернуть ошибку CLI как есть; `headed:true` двигает курсор, скилл обязан предупреждать |
| `screenshot({app?, window_id?, screen?, save_path?})` | `screenshot` | base64 → image content; `save_path` → файл |
| `clipboard_get()` / `clipboard_set({text})` / `clipboard_clear()` | `clipboard-get/set/clear` | |
| `wait({app?, wait_for?, wait_for_gone?, timeout_ms?})` | `wait` / `--wait-for` | полл до появления/исчезновения элемента; вместо фиксированных снов |
| `batch({commands:[{command,args}], stop_on_error?, timeout_ms?})` | `batch` | ограниченная последовательность без участия модели |
| `launch({app})` / `close_app({app})` | `launch` / `close-app` | |

Не экспортируются в v1: `mouse-*`, `key-down/up`, `focus-window`, `move/resize/minimize/maximize`, `open-system-surface`, `notification-*`, `session`/`trace`/`cursor-overlay`, `--session`/`--agent-id`.

## 7. Скилл

`skills/agent-desktop/SKILL.md`, язык — английский (совпадает с документацией CLI, нет дрейфа переводов), `description` двуязычный (ru + en триггеры: «click button», «управлять приложением», «computer use»…). Содержимое — адаптация `agent-desktop skills get desktop` и `get platform` (macOS):

- цикл observe→act→verify; skeleton → drill (`--root`) для плотных приложений; surfaces (menu/sheet/alert) после действий;
- refs: квалифицированные, живут один снапшот; `STALE_REF`/`SNAPSHOT_NOT_FOUND` → новый снапшот;
- `disposition.retry == "safe"` — единственное условие повтора; иначе повторное наблюдение (`get`/`is`/snapshot, `details.post_state`);
- headless-дисциплина: без фокуса и курсора; `headed`/`drag` — только осознанно;
- `wait` вместо фиксированных снов; `batch` для целевых последовательностей;
- границы замены (перенос границ kimi-cu): фоновые операции, верификация фактического эффекта, приватность снапшотов/скриншотов, запросы на отправку/удаление/оплату — только в явно авторизованном объёме.

## 8. Манифест и установка

`kimi.plugin.json`: `name:"agent-desktop"`, skills `./skills/`, `interface.platforms:["macos"]`, `mcpServers.mac = {command:"node", args:["./bin/agent-desktop-mcp.mjs"], cwd:"./", enabledTools:[…из §6]}`.

`bin/setup.sh`: проверяет node/npm, ставит `npm i -g agent-desktop` при отсутствии, запускает `agent-desktop permissions` и открывает нужные панели System Settings. README описывает one-time шаги (права Kimi Code.app) и порядок перехода: установить плагин → перезапустить сессию/переподключить MCP → принять → отключить kimi-cu в настройках плагинов (действие пользователя).

## 9. Верификация

1. **Протокол:** `tests/probe.mjs` — initialize/tools/list/tools/call(`status`) в сервер по stdio; assert форм ответов.
2. **Refs между процессами (спайк до написания инструментов):** `snapshot` в одном процессе → `click` по его ref из другого процесса. Это документированный основной цикл CLI (README quick start — три отдельных вызова), но он проверяется живым тестом первым. Если refs не переживают процесс — контингенция (отдельное решение, не молча): `--session` namespace в v1 либо долгоживущий дочерний процесс CLI.
3. **Живой цикл** (права выданы): `status` → `list_apps` → `get_app_state(Finder, mode:"ax")` → `click` по ref → повторный `snapshot` подтверждает эффект.
4. **Ввод:** TextEdit/Notes: `type_text` (append), `type_text replace:true` (= set-value), `press_key`, clipboard roundtrip, `screenshot` возвращает валидный PNG-base64 image block (проверить даунскейл до 2048).
5. **Refs:** после изменения UI клик по старому ref → `STALE_REF` от CLI → новый снапшот → успех.
6. **Batch:** 2–3 команды с `stop_on_error` одной транзакцией.
7. **Приёмка пользователя:** сценарий из его реальной работы; затем отключение kimi-cu.

## 10. Риски

- Обновление/переподпись Kimi Code.app может сбросить TCC-гранты → `status` это показывает, README описывает восстановление.
- Chromium/Electron: AX-дерево появляется после активации accessibility — CLI имеет `--force-electron-a11y`, `--timeout-ms`; скилл учит поднимать таймаут.
- `drag` может требовать `--headed` → физическое движение курсора; обявлено в скилле как осознанное действие.
- Дрейф протокола хоста: если handshake не сойдётся, явное решение — перейти на официальный SDK (не молча).

## 11. Решения, принятые автором дизайна (мои вызовы)

- Ноль npm-зависимостей, hand-rolled JSON-RPC — handshake 2025-06-18 проверен на живом мосте.
- SKILL.md на английском, description двуязычный.
- `get_app_state` default `mode:"full"` — паритет с kimi-cu.
- Сервер не хранит состояния между вызовами (кроме лога снапшот-id не ведём — refs живут в CLI-сессии по умолчанию).
- Ошибки — только `isError:true` + текст конверта; никаких автоповторов.
- Скриншоты ужимаются до длинной грани 2048 px системным `sips` (raw — по параметру `full_resolution`): паритет с kimi-cu и защита контекста от многометровых Retina-снимков.
- Текстовый выбор диапазона (kimi-cu `select_text`) не переносится — в CLI нет эквивалента; v1 даёт `select_option` (dropdown). Помечено как известная деградация, не молчаливая потеря.
- `type_text replace:true` = `set-value`, `replace:false` = `type` (append) — без самодельных «очистить и напечатать».
- Одновременная жизнь с kimi-cu во время миграции безопасна: хост неймспейсирует MCP-инструменты по серверу (`mcp__kimi-cu__*` vs `mcp__agent-desktop__*` — видно в текущей сессии); скилл не воюет с чужими инструментами, отключение kimi-cu — шаг приёмки.
