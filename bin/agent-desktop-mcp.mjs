#!/usr/bin/env node
/**
 * agent-desktop MCP server for Kimi Code Desktop.
 *
 * Zero dependencies. JSON-RPC 2.0 over stdio (newline-delimited).
 * Every tools/call spawns one `agent-desktop` CLI process and returns its
 * JSON envelope. The server never retries on its own: retry decisions belong
 * to the model, guided by `error.disposition.retry`.
 *
 * Privacy: snapshot, screenshot and clipboard payloads are returned to the
 * client only; the server keeps no files and writes no logs.
 */
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "agent-desktop";
const CLI = process.env.AGENT_DESKTOP_BIN || "agent-desktop";
const SIPS = "/usr/bin/sips";
const MAX_LINE = 10 * 1024 * 1024;
const OUT_CAP = 16 * 1024 * 1024;

let SERVER_VERSION = "0.1.0";
try {
  SERVER_VERSION = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).version || SERVER_VERSION;
} catch {}

const INSTALL_HINT =
  `agent-desktop CLI not found ('${CLI}'). Install it once with: npm install -g agent-desktop` +
  ` (node >= 18 required), then run 'agent-desktop permissions' and grant Accessibility +` +
  ` Screen Recording to the Kimi Code app. Or run this plugin's bin/setup.sh.`;

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

function runCli(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(CLI, args.map(String), { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ spawnError: e });
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (s, chunk) => (s.length < OUT_CAP ? s + chunk : s);
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000).unref();
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout = append(stdout, d.toString("utf8")); });
    child.stderr.on("data", (d) => { stderr = append(stderr, d.toString("utf8")); });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ spawnError: e });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

function extractEnvelope(r) {
  if (r.spawnError) {
    if (r.spawnError.code === "ENOENT") {
      return { error: { code: "CLI_NOT_FOUND", message: INSTALL_HINT } };
    }
    return { error: { code: "SPAWN_FAILED", message: String(r.spawnError?.message || r.spawnError) } };
  }
  const lines = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const env = JSON.parse(lines[i]);
      if (env && typeof env === "object" && "ok" in env) return { envelope: env, stderr: r.stderr };
    } catch {}
  }
  if (r.timedOut) {
    return { error: { code: "SERVER_TIMEOUT", message: "agent-desktop did not finish within the server-side timeout", stderr_tail: r.stderr.slice(-2000) } };
  }
  return {
    error: {
      code: "BAD_OUTPUT",
      message: "agent-desktop did not print a JSON envelope",
      exitCode: r.exitCode,
      stdout_tail: r.stdout.slice(-1000),
      stderr_tail: r.stderr.slice(-1000),
    },
  };
}

// ---------------------------------------------------------------------------
// Content shaping
// ---------------------------------------------------------------------------

const T = (text) => ({ type: "text", text });
const envText = (env) => JSON.stringify(env, null, 2);

function errorObjectToContent(e) {
  const parts = [`agent-desktop ${e.code || "ERROR"}: ${e.message || "unknown error"}`];
  if (e.suggestion) parts.push(`suggestion: ${e.suggestion}`);
  if (e.disposition) parts.push(`disposition: ${JSON.stringify(e.disposition)}`);
  if (e.stderr_tail) parts.push(`stderr: ${e.stderr_tail}`);
  return [T(parts.join("\n"))];
}

function envelopeToResult(env, extra = []) {
  if (!env.ok) return { content: [...errorObjectToContent(env.error || {}), ...extra], isError: true };
  return { content: [T(envText(env)), ...extra] };
}

async function callCli(argv, { timeoutMs = 60000 } = {}) {
  const x = extractEnvelope(await runCli(argv, { timeoutMs }));
  if (x.error) return { content: errorObjectToContent(x.error), isError: true };
  return envelopeToResult(x.envelope);
}

function serverTimeout(ms) {
  return Math.min(300000, Math.max(20000, (Number(ms) || 0) + 15000));
}

// ---------------------------------------------------------------------------
// Screenshot pipeline (CLI writes a PNG file; optional sips downscale; image block)
// ---------------------------------------------------------------------------

async function capturePng({ app, window_id, screen, save_path, full_resolution, timeout_ms } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "agent-desktop-shot-"));
  try {
    const target = save_path || join(dir, "shot.png");
    const argv = ["screenshot", target];
    if (app) argv.push("--app", app);
    if (window_id) argv.push("--window-id", window_id);
    if (screen != null) argv.push("--screen", screen);
    const r = await runCli(argv, { timeoutMs: serverTimeout(timeout_ms) });
    const x = extractEnvelope(r);
    if (x.error) return { content: errorObjectToContent(x.error), isError: true };
    const env = x.envelope;
    if (!env.ok) return { content: errorObjectToContent(env.error || {}), isError: true };
    if (save_path) return { content: [T(`${envText(env)}\nimage saved to: ${target}`)] };
    if (!full_resolution) {
      try { spawnSync(SIPS, ["-Z", "2048", target], { stdio: "ignore" }); } catch {}
    }
    const png = await readFile(target);
    return { content: [T(envText(env)), { type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Flag helpers
// ---------------------------------------------------------------------------

function pushCommon(argv, a = {}) {
  if (a.app) argv.push("--app", a.app);
  if (a.window_id) argv.push("--window-id", a.window_id);
}

function pushRefActionCommon(argv, a = {}) {
  if (a.timeout_ms != null) argv.push("--timeout-ms", a.timeout_ms);
}

function pushWaitCommon(argv, a = {}) {
  if (a.wait_for) argv.push("--wait-for", a.wait_for);
  if (a.wait_for_gone) argv.push("--wait-for-gone", a.wait_for_gone);
  if (a.wait_timeout_ms != null) argv.push("--wait-timeout", a.wait_timeout_ms);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const s = (description, properties = {}, required = []) => ({ type: "object", description, properties, required });

const TOOLS = [
  {
    name: "status",
    description:
      "Health check: agent-desktop CLI version, platform, permission states (accessibility / screen_recording / automation) with fix suggestions. " +
      "Call this first when tools start failing with PERM_DENIED, or after a Kimi Code app update.",
    inputSchema: s("Health check"),
    run: async () => {
      const st = extractEnvelope(await runCli(["status"], { timeoutMs: 30000 }));
      const pm = extractEnvelope(await runCli(["permissions"], { timeoutMs: 30000 }));
      if (st.error && pm.error) return { content: errorObjectToContent(st.error.code === "CLI_NOT_FOUND" ? st.error : pm.error), isError: true };
      const blocks = [];
      if (st.envelope) blocks.push(T(`status:\n${envText(st.envelope)}`));
      if (pm.envelope) blocks.push(T(`permissions:\n${envText(pm.envelope)}`));
      for (const e of [st.error, pm.error]) if (e) blocks.push(T(JSON.stringify({ ok: false, error: e }, null, 2)));
      return { content: blocks };
    },
  },

  {
    name: "list_apps",
    description:
      "List running GUI applications (name, bundle_id, pid). The CLI only lists running apps; to find an app that is not running, use launch. " +
      "Use this to locate a target before get_app_state. The running_only parameter is accepted for compatibility and ignored.",
    inputSchema: s("List running GUI apps", {
      app: { type: "string", description: "Filter by app name" },
      running_only: { type: "boolean", description: "Ignored: the CLI lists running GUI apps only" },
      timeout_ms: { type: "integer" },
    }),
    run: (a) => {
      const argv = ["list-apps"];
      if (a.app) argv.push("--app", a.app);
      if (a.timeout_ms != null) argv.push("--timeout-ms", a.timeout_ms);
      return callCli(argv, { timeoutMs: serverTimeout(a.timeout_ms) });
    },
  },

  {
    name: "list_windows",
    description: "List visible windows (window ids, titles, app). Use a window_id to disambiguate when an app has several windows or same-named instances.",
    inputSchema: s("List visible windows", {
      app: { type: "string", description: "Filter by exact case-insensitive app name" },
      timeout_ms: { type: "integer" },
    }),
    run: (a) => {
      const argv = ["list-windows"];
      if (a.app) argv.push("--app", a.app);
      if (a.timeout_ms != null) argv.push("--timeout-ms", a.timeout_ms);
      return callCli(argv, { timeoutMs: serverTimeout(a.timeout_ms) });
    },
  },

  {
    name: "get_app_state",
    description:
      "Observe an application: accessibility tree as JSON with qualified refs (@snapshot:element) usable in click/type/set_value/..., " +
      "plus a PNG screenshot depending on mode. mode 'full' (default) = tree + screenshot image; 'ax' = tree only; 'image' = screenshot only. " +
      "Dense apps: skeleton:true for a shallow map, then root_ref to drill into one region. Menus/sheets/alerts opened by an action: surface parameter.",
    inputSchema: s("Observe app UI", {
      app: { type: "string", description: "App name (from list_apps)" },
      window_id: { type: "string", description: "Scope to one window id (from list_windows); required when several windows match" },
      mode: { type: "string", enum: ["full", "ax", "image"], default: "full" },
      interactive_only: { type: "boolean", default: true, description: "Only elements an agent can act on (CLI -i)" },
      skeleton: { type: "boolean", description: "Shallow overview with children_count on truncated containers" },
      compact: { type: "boolean", description: "Collapse single-child unnamed nodes" },
      max_depth: { type: "integer", minimum: 1, maximum: 50 },
      include_bounds: { type: "boolean", description: "Include element bounds x/y/width/height" },
      root_ref: { type: "string", description: "Start traversal from this ref instead of the window root" },
      surface: { type: "string", description: "Snapshot a surface instead of the window: menu, menubar, sheet, popover, alert, dock, ... " },
      wait_for: { type: "string", description: "Poll until this role:text selector appears, then snapshot" },
      wait_for_gone: { type: "string", description: "Poll until this role:text selector disappears, then snapshot" },
      wait_timeout_ms: { type: "integer" },
      timeout_ms: { type: "integer", description: "Observation deadline in ms (default 3000; raise for slow Chromium apps)" },
      full_resolution: { type: "boolean", description: "Skip the 2048px downscale of the screenshot" },
    }),
    run: async (a) => {
      const mode = a.mode || "full";
      if (mode === "image") return capturePng(a);
      const argv = ["snapshot"];
      pushCommon(argv, a);
      if (a.interactive_only !== false) argv.push("-i");
      if (a.skeleton) argv.push("--skeleton");
      if (a.compact) argv.push("--compact");
      if (a.include_bounds) argv.push("--include-bounds");
      if (a.max_depth != null) argv.push("--max-depth", a.max_depth);
      if (a.root_ref) argv.push("--root", a.root_ref);
      if (a.surface) argv.push("--surface", a.surface);
      pushWaitCommon(argv, a);
      if (a.timeout_ms != null) argv.push("--timeout-ms", a.timeout_ms);
      const r = await runCli(argv, { timeoutMs: serverTimeout(a.timeout_ms ?? a.wait_timeout_ms) });
      const x = extractEnvelope(r);
      if (x.error) return { content: errorObjectToContent(x.error), isError: true };
      if (!x.envelope.ok) return envelopeToResult(x.envelope);
      const content = [T(envText(x.envelope))];
      if (mode === "full") {
        const shot = await capturePng({ app: a.app, window_id: a.window_id, full_resolution: a.full_resolution });
        content.push(...shot.content);
        if (shot.isError) return { content, isError: true };
      }
      return { content };
    },
  },

  {
    name: "find",
    description:
      "Search elements by role/name/value/text without a full snapshot. Returns matches with refs. " +
      "Use --exact for exact name matches; first:true for a single result. Prefer find over snapshot when you know what you are looking for.",
    inputSchema: s("Find elements", {
      app: { type: "string" },
      window_id: { type: "string" },
      role: { type: "string", description: "Accessibility role: button, textfield, checkbox, ..." },
      name: { type: "string", description: "Match accessible name/label" },
      text: { type: "string", description: "Match text in name, value, title or description" },
      value: { type: "string", description: "Match current value" },
      exact: { type: "boolean", description: "Exact case-insensitive name/value match" },
      root_ref: { type: "string", description: "Search only inside this ref's subtree" },
      surface: { type: "string", description: "Search a surface (menubar, menu, sheet...) instead of the window" },
      first: { type: "boolean" },
      last: { type: "boolean" },
      nth: { type: "integer", description: "Return the Nth match (0-indexed)" },
      count: { type: "boolean", description: "Return match count only" },
      limit: { type: "integer", description: "Max matches (default 50, 0 = all)" },
      timeout_ms: { type: "integer" },
    }),
    run: (a) => {
      const argv = ["find"];
      pushCommon(argv, a);
      for (const [flag, key] of [["--role", "role"], ["--name", "name"], ["--text", "text"], ["--value", "value"]]) {
        if (a[key]) argv.push(flag, a[key]);
      }
      if (a.exact) argv.push("--exact");
      if (a.root_ref) argv.push("--root", a.root_ref);
      if (a.surface) argv.push("--surface", a.surface);
      if (a.first) argv.push("--first");
      if (a.last) argv.push("--last");
      if (a.nth != null) argv.push("--nth", a.nth);
      if (a.count) argv.push("--count");
      if (a.limit != null) argv.push("--limit", a.limit);
      if (a.timeout_ms != null) argv.push("--timeout-ms", a.timeout_ms);
      return callCli(argv, { timeoutMs: serverTimeout(a.timeout_ms) });
    },
  },

  {
    name: "click",
    description: "Click an element by ref (accessibility press, headless). count 2/3 map to double-click/triple-click; button 'right' maps to right-click. Refs come from the latest snapshot/find and die with it.",
    inputSchema: s("Click element", {
      ref: { type: "string", description: "Qualified ref from the latest snapshot, e.g. @s8f3k2p9:e12" },
      count: { type: "integer", enum: [1, 2, 3], default: 1 },
      button: { type: "string", enum: ["left", "right"], default: "left" },
      timeout_ms: { type: "integer" },
    }, ["ref"]),
    run: (a) => {
      if (a.count > 1 && a.button === "right") {
        return { content: [T("invalid combination: count>1 with button 'right' is not supported by the CLI")], isError: true };
      }
      const cmd = a.count === 3 ? "triple-click" : a.count === 2 ? "double-click" : a.button === "right" ? "right-click" : "click";
      const argv = [cmd, a.ref];
      pushRefActionCommon(argv, a);
      return callCli(argv, { timeoutMs: serverTimeout(a.timeout_ms) });
    },
  },

  {
    name: "type_text",
    description:
      "Insert text into a text element by ref. Appends at the element's input position by default; replace:true sets the whole value via set-value instead (atomic, no duplication). " +
      "For plain whole-value writes prefer set_value directly.",
    inputSchema: s("Insert text", {
      ref: { type: "string" },
      text: { type: "string" },
      replace: { type: "boolean", default: false, description: "true = replace the whole value (set-value); false = append (type)" },
      timeout_ms: { type: "integer" },
    }, ["ref", "text"]),
    run: (a) => {
      const argv = a.replace ? ["set-value", a.ref, a.text] : ["type", a.ref, a.text];
      pushRefActionCommon(argv, a);
      return callCli(argv, { timeoutMs: serverTimeout(a.timeout_ms) });
    },
  },

  {
    name: "set_value",
    description: "Set an element value directly via the accessibility attribute. Works on text fields, sliders, steppers and other value-bearing elements.",
    inputSchema: s("Set element value", {
      ref: { type: "string" },
      value: { type: "string", description: "New value as a string (numbers accepted as strings)" },
      timeout_ms: { type: "integer" },
    }, ["ref", "value"]),
    run: (a) => {
      const argv = ["set-value", a.ref, a.value];
      pushRefActionCommon(argv, a);
      return callCli(argv, { timeoutMs: serverTimeout(a.timeout_ms) });
    },
  },

  {
    name: "press_key",
    description:
      "Send a key combo: return, escape, cmd+c, shift+tab, ... With app/window_id the keys go to that process without focusing it (headless); " +
      "without a target they go to the system focus. Dangerous shortcuts may be refused unless force:true.",
    inputSchema: s("Press key combo", {
      combo: { type: "string", description: "e.g. 'return', 'escape', 'cmd+c', 'shift+tab'" },
      app: { type: "string", description: "Deliver to this app without focusing it" },
      window_id: { type: "string" },
      force: { type: "boolean", description: "Send even if flagged as a dangerous shortcut" },
      timeout_ms: { type: "integer" },
    }, ["combo"]),
    run: (a) => {
      const argv = ["press", a.combo];
      pushCommon(argv, a);
      if (a.force) argv.push("--force");
      if (a.timeout_ms != null) argv.push("--timeout-ms", a.timeout_ms);
      return callCli(argv, { timeoutMs: serverTimeout(a.timeout_ms) });
    },
  },

  {
    name: "scroll",
    description: "Scroll an element via accessibility actions: direction up/down/left/right, amount in scroll units (default 3). Re-snapshot afterwards; refs may go stale.",
    inputSchema: s("Scroll element", {
      ref: { type: "string" },
      direction: { type: "string", enum: ["up", "down", "left", "right"], default: "down" },
      amount: { type: "integer", default: 3 },
      timeout_ms: { type: "integer" },
    }, ["ref"]),
    run: (a) => {
      const argv = ["scroll", a.ref, "--direction", a.direction || "down", "--amount", a.amount ?? 3];
      pushRefActionCommon(argv, a);
      return callCli(argv, { timeoutMs: serverTimeout(a.timeout_ms) });
    },
  },

  {
    name: "select_option",
    description: "Select an option in a list or dropdown by value. This is not text-range selection: the CLI has no text-selection primitive.",
    inputSchema: s("Select dropdown/list option", {
      ref: { type: "string" },
      value: { type: "string", description: "Option value to select" },
      timeout_ms: { type: "integer" },
    }, ["ref", "value"]),
    run: (a) => {
      const argv = ["select", a.ref, a.value];
      pushRefActionCommon(argv, a);
      return callCli(argv, { timeoutMs: serverTimeout(a.timeout_ms) });
    },
  },

  {
    name: "toggle",
    description: "Toggle a checkbox or switch by ref. Verify the resulting state in a fresh snapshot; toggling twice flips back.",
    inputSchema: s("Toggle checkbox/switch", {
      ref: { type: "string" },
      timeout_ms: { type: "integer" },
    }, ["ref"]),
    run: (a) => {
      const argv = ["toggle", a.ref];
      pushRefActionCommon(argv, a);
      return callCli(argv, { timeoutMs: serverTimeout(a.timeout_ms) });
    },
  },

  {
    name: "drag",
    description:
      "Drag from one element/ref to another. PHYSICAL: requires headed:true and moves the real cursor over the screen — only when the task explicitly needs it " +
      "(canvas, timeline, freeform). Also accepts from_xy/to_xy ('x,y' screen points) instead of refs.",
    inputSchema: s("Drag (physical, headed)", {
      from_ref: { type: "string" },
      to_ref: { type: "string" },
      from_xy: { type: "string", description: "'x,y' coordinates instead of from_ref" },
      to_xy: { type: "string", description: "'x,y' coordinates instead of to_ref" },
      headed: { type: "boolean", default: false, description: "Must be true: the CLI delivers drags only via physical input" },
      duration_ms: { type: "integer", description: "Drag duration in ms" },
      drop_delay_ms: { type: "integer", description: "Hold over destination before release (default 500)" },
      timeout_ms: { type: "integer" },
    }),
    run: (a) => {
      if (!a.headed) {
        return {
          content: [T("drag is a physical input action: the CLI requires --headed. Confirm the task really needs cursor movement, then retry with headed:true.")],
          isError: true,
        };
      }
      if (!a.from_ref && !a.from_xy) return { content: [T("from_ref or from_xy is required")], isError: true };
      if (!a.to_ref && !a.to_xy) return { content: [T("to_ref or to_xy is required")], isError: true };
      const argv = ["drag", "--headed"];
      if (a.from_ref) argv.push("--from", a.from_ref);
      if (a.from_xy) argv.push("--from-xy", a.from_xy);
      if (a.to_ref) argv.push("--to", a.to_ref);
      if (a.to_xy) argv.push("--to-xy", a.to_xy);
      if (a.duration_ms != null) argv.push("--duration", a.duration_ms);
      if (a.drop_delay_ms != null) argv.push("--drop-delay", a.drop_delay_ms);
      if (a.timeout_ms != null) argv.push("--timeout-ms", a.timeout_ms);
      return callCli(argv, { timeoutMs: serverTimeout(a.timeout_ms) });
    },
  },

  {
    name: "screenshot",
    description:
      "PNG screenshot of an app window (or a whole display via screen index). Returned as an image block, downscaled to 2048px unless full_resolution:true. " +
      "save_path saves the raw PNG to a file instead of returning it.",
    inputSchema: s("Take screenshot", {
      app: { type: "string" },
      window_id: { type: "string" },
      screen: { type: "integer", description: "Display index (0 = primary)" },
      save_path: { type: "string", description: "Save the PNG to this path instead of returning it" },
      full_resolution: { type: "boolean" },
      timeout_ms: { type: "integer" },
    }),
    run: (a) => capturePng(a),
  },

  {
    name: "clipboard_get",
    description: "Read the clipboard. format 'text' (default) returns plain text; 'image' returns a PNG image block; 'auto'/'file-urls' return structured data.",
    inputSchema: s("Read clipboard", {
      format: { type: "string", enum: ["text", "auto", "image", "file-urls"], default: "text" },
      timeout_ms: { type: "integer" },
    }),
    run: async (a) => {
      const format = a.format || "text";
      if (format !== "image") return callCli(["clipboard-get", "--format", format], { timeoutMs: 30000 });
      const dir = await mkdtemp(join(tmpdir(), "agent-desktop-clip-"));
      try {
        const file = join(dir, "clipboard.png");
        const x = extractEnvelope(await runCli(["clipboard-get", "--format", "image", "--out", file], { timeoutMs: 30000 }));
        if (x.error) return { content: errorObjectToContent(x.error), isError: true };
        if (!x.envelope.ok) return envelopeToResult(x.envelope);
        const png = await readFile(file);
        return { content: [T(envText(x.envelope)), { type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
      } finally {
        rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  },

  {
    name: "clipboard_set",
    description: "Write text (or a PNG from a file path) to the clipboard. Provide exactly one of text / image_path.",
    inputSchema: s("Write clipboard", {
      text: { type: "string" },
      image_path: { type: "string", description: "Path to a PNG file" },
      timeout_ms: { type: "integer" },
    }),
    run: (a) => {
      if (!!a.text === !!a.image_path) return { content: [T("provide exactly one of text / image_path")], isError: true };
      const argv = ["clipboard-set"];
      if (a.image_path) argv.push("--image", a.image_path);
      else argv.push(a.text);
      if (a.timeout_ms != null) argv.push("--timeout-ms", a.timeout_ms);
      return callCli(argv, { timeoutMs: 30000 });
    },
  },

  {
    name: "clipboard_clear",
    description: "Clear the clipboard.",
    inputSchema: s("Clear clipboard", {}),
    run: () => callCli(["clipboard-clear"], { timeoutMs: 30000 }),
  },

  {
    name: "wait",
    description:
      "Block until a condition instead of sleeping a fixed time: ms (fixed wait), element ref appears with a predicate (exists/enabled/visible/actionable/value), " +
      "text appears in an app's tree, a window title appears, a lifecycle event (window-opened, app-launched, focus-changed, surface-appeared...), or a menu opens/closes.",
    inputSchema: s("Wait for condition", {
      ms: { type: "integer", description: "Fixed wait in ms (use only as a last resort)" },
      element: { type: "string", description: "Block until this element ref appears" },
      predicate: { type: "string", enum: ["exists", "enabled", "visible", "actionable", "value"], description: "Element wait predicate (with element)" },
      value: { type: "string", description: "Expected value for predicate=value" },
      text: { type: "string", description: "Block until this text appears in the app's tree" },
      count: { type: "integer", description: "Expected match count for text waits" },
      window: { type: "string", description: "Block until a window with this title appears" },
      event: { type: "string", description: "window-opened | window-closed | app-launched | app-terminated | focus-changed | surface-appeared | surface-dismissed" },
      menu: { type: "boolean", description: "Block until a menu surface is open" },
      menu_closed: { type: "boolean", description: "Block until the menu surface is dismissed" },
      notification: { type: "boolean", description: "Block until a new notification arrives" },
      app: { type: "string", description: "Scope element/window/text waits to this app" },
      window_id: { type: "string", description: "Narrow event waits to one window" },
      timeout_ms: { type: "integer", description: "Condition timeout (default 30000)" },
    }),
    run: (a) => {
      const argv = ["wait"];
      let hasSelector = false;
      for (const key of ["element", "text", "window", "event"]) {
        if (a[key]) { argv.push(`--${key}`, a[key]); hasSelector = true; }
      }
      for (const [flag, key] of [["--menu", "menu"], ["--menu-closed", "menu_closed"], ["--notification", "notification"]]) {
        if (a[key]) { argv.push(flag); hasSelector = true; }
      }
      if (!hasSelector && a.ms == null) return { content: [T("provide a condition (element/text/window/event/menu/...) or ms")], isError: true };
      if (a.predicate) argv.push("--predicate", a.predicate);
      if (a.value) argv.push("--value", a.value);
      if (a.count != null) argv.push("--count", a.count);
      if (a.app) argv.push("--app", a.app);
      if (a.window_id) argv.push("--window-id", a.window_id);
      if (a.timeout_ms != null) argv.push("--timeout", a.timeout_ms);
      if (!hasSelector && a.ms != null) argv.push(String(a.ms));
      return callCli(argv, { timeoutMs: serverTimeout(a.timeout_ms) });
    },
  },

  {
    name: "batch",
    description:
      "Execute a bounded, sequential, NON-atomic list of CLI commands in one call: [{command:'click',args:['@s:e1']},...]. " +
      "Only batch steps whose targets you have already observed and that stay valid; stop batching when the next step needs a fresh look at the UI. " +
      "stop_on_error halts on the first failure; the batch is not a transaction, already-delivered steps do not roll back.",
    inputSchema: s("Run command batch", {
      commands: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            command: { type: "string", description: "CLI command name, e.g. click, type, set-value, press, scroll" },
            args: { type: "array", items: { type: "string" }, description: "Positional args and flags as strings, e.g. ['@s8f3k2p9:e12'] or ['--direction','down']" },
          },
          required: ["command"],
        },
      },
      stop_on_error: { type: "boolean", default: false },
      timeout_ms: { type: "integer", default: 60000, description: "Wall-clock budget for the whole batch" },
    }, ["commands"]),
    run: (a) => {
      for (const c of a.commands) {
        if (!c || typeof c.command !== "string") return { content: [T("each batch item needs a command string")], isError: true };
        if (c.args != null && !Array.isArray(c.args)) return { content: [T("args must be an array of strings")], isError: true };
      }
      const argv = ["batch", JSON.stringify(a.commands)];
      if (a.stop_on_error) argv.push("--stop-on-error");
      argv.push("--timeout-ms", a.timeout_ms ?? 60000);
      return callCli(argv, { timeoutMs: serverTimeout(a.timeout_ms ?? 60000) });
    },
  },

  {
    name: "launch",
    description: "Launch an application and return once its process is running. activate:true brings it forward so it presents a window (visible side effect); args passes command-line arguments.",
    inputSchema: s("Launch app", {
      app: { type: "string", description: "App name or path" },
      activate: { type: "boolean", default: false, description: "Bring the app forward and wait for a window" },
      args: { type: "array", items: { type: "string" }, description: "Command-line arguments for the launched app" },
      no_attach: { type: "boolean", description: "Fail if the app is already running" },
      timeout_ms: { type: "integer", default: 30000 },
    }, ["app"]),
    run: (a) => {
      const argv = ["launch", a.app];
      if (a.activate) argv.push("--activate");
      if (a.no_attach) argv.push("--no-attach");
      for (const v of a.args || []) argv.push("--arg", v);
      if (a.timeout_ms != null) argv.push("--timeout", a.timeout_ms);
      return callCli(argv, { timeoutMs: serverTimeout(a.timeout_ms ?? 30000) });
    },
  },

  {
    name: "close_app",
    description: "Quit an application gracefully; force:true terminates its processes instead.",
    inputSchema: s("Close app", {
      app: { type: "string" },
      force: { type: "boolean", default: false },
      timeout_ms: { type: "integer" },
    }, ["app"]),
    run: (a) => {
      const argv = ["close-app", a.app];
      if (a.force) argv.push("--force");
      return callCli(argv, { timeoutMs: serverTimeout(a.timeout_ms) });
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

let writeChain = Promise.resolve();
function send(obj) {
  writeChain = writeChain.then(() => new Promise((res) => process.stdout.write(JSON.stringify(obj) + "\n", res)));
}

function result(id, result) { send({ jsonrpc: "2.0", id, result }); }
function error(id, code, message, data) { send({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } }); }

async function handleRequest(id, method, params) {
  switch (method) {
    case "initialize": {
      result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Computer use via the agent-desktop CLI. Loop: get_app_state/find -> act by ref (click/type_text/set_value/press_key/scroll/...) -> observe again. " +
          "Refs (@snapshot:element) are valid for one snapshot; STALE_REF means take a new one. Retry an action only when error.disposition.retry is 'safe'. " +
          "Everything is headless: no cursor movement, no focus stealing; drag is the only physical tool and requires headed:true.",
      });
      return;
    }
    case "ping": {
      result(id, {});
      return;
    }
    case "tools/list": {
      result(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      return;
    }
    case "tools/call": {
      const name = params?.name;
      const tool = TOOL_MAP.get(name);
      if (!tool) return error(id, -32602, `unknown tool: ${name}`);
      const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
      try {
        const out = await tool.run(args);
        result(id, { content: out.content, ...(out.isError ? { isError: true } : {}) });
      } catch (e) {
        result(id, { content: [T(`tool '${name}' crashed: ${e?.stack || e}`)], isError: true });
      }
      return;
    }
    default:
      error(id, -32601, `method not found: ${method}`);
  }
}

function handleMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;
  if (!method) return; // a response to a request we never sent
  if (id === undefined || id === null) return; // notification (initialized, cancelled, ...)
  writeChain = writeChain.then(() => handleRequest(id, method, params));
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim() || line.length > MAX_LINE) return;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return error(null, -32700, "Parse error");
  }
  if (Array.isArray(parsed)) parsed.forEach(handleMessage);
  else handleMessage(parsed);
});
rl.on("close", () => process.exit(0));
