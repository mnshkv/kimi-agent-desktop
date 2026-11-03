#!/usr/bin/env node
// READ-ONLY live checks against the real MCP server (requires Accessibility +
// Screen Recording granted to the Kimi Code app). Never clicks or types.
// Usage: node tests/live.mjs
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "bin", "agent-desktop-mcp.mjs");

const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "inherit"] });
const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
let nextId = 1;

function call(name, args) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${name}`)); }, 120000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
}
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id != null && pending.has(msg.id)) { const cb = pending.get(msg.id); pending.delete(msg.id); cb(msg); }
});

const text = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const images = (r) => (r?.content || []).filter((c) => c.type === "image");
// tools may return several text blocks (e.g. snapshot envelope + screenshot envelope); parse the first valid one
const firstEnvelope = (r) => {
  for (const c of r?.content || []) {
    if (c.type !== "text") continue;
    try { const j = JSON.parse(c.text); if (j && typeof j === "object" && "ok" in j) return j; } catch {}
  }
  return null;
};
const envelope = (r) => firstEnvelope(r) ?? (() => { try { return JSON.parse(text(r)); } catch { return null; } })();
let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? " — " + String(detail).slice(0, 250) : ""}`); }
};

// 0. permissions first — status returns two prefixed text blocks; parse each
const st = await call("status", {});
const blockJson = (prefix) => {
  const block = (st?.content || []).find((c) => c.type === "text" && c.text.startsWith(prefix));
  try { return JSON.parse(block.text.slice(prefix.length)); } catch { return null; }
};
const perm = blockJson("permissions:\n")?.data ?? {};
const states = [perm.accessibility?.state, perm.screen_recording?.state];
check("permissions granted (accessibility, screen_recording)", states.every((s) => s === "granted"), JSON.stringify(perm));

// 1. pick a target window: accessible + visible; list-windows data is a bare array
const wins = envelope(await call("list_windows", {}));
const windowList = Array.isArray(wins?.data) ? wins.data : (wins?.data?.windows ?? []);
check("list_windows ok:true with window array", wins?.ok === true && Array.isArray(windowList), text(wins).slice(0, 200));
let target = windowList.find((w) => w.accessible && w.visible && w.id) || windowList.find((w) => w.visible && w.id);
if (!target) {
  console.log("SKIP live tree checks: no visible windows found");
  child.kill("SIGTERM");
  process.exit(failures === 0 ? 0 : 1);
}
const targetApp = target.app_name || target.app || target.owner;
const targetWindowId = target.window_id ?? target.id;
console.log(`   target: ${targetApp} (window ${targetWindowId}) "${target.title ?? ""}"`);
// app_name from list-windows is truncated — work by window_id, not by app name

// 2. full observation: tree with refs + screenshot image block (window-scoped)
const obs = await call("get_app_state", { window_id: String(targetWindowId), mode: "full", compact: true });
const obsEnv = envelope(obs);
check("get_app_state(full) ok:true", obsEnv?.ok === true, text(obs).slice(0, 300));
const obsText = text(obs);
const refMatches = obsText.match(/@[a-z0-9]+:e\d+/gi) || [];
check("tree contains qualified refs", refMatches.length > 0, obsText.slice(0, 200));
check("screenshot image block present", images(obs).length === 1);
check("image block is PNG base64", (images(obs)[0]?.data || "").startsWith("iVBORw0KGgo") && images(obs)[0]?.mimeType === "image/png");
const pngBytes = Buffer.from(images(obs)[0]?.data || "", "base64").length;
console.log(`   refs in tree: ${refMatches.length}, screenshot: ${Math.round(pngBytes / 1024)} KiB (downscaled)`);

// 3. find by FULL app name (list-windows truncates app_name, and CLI stores it in the snapshot session;
//    ref resolution in later processes re-attaches by that stored name, so seed snapshots with the full name)
const appsEnv = envelope(await call("list_apps", { running_only: true }));
const byPid = (appsEnv?.data?.apps || []).find((a) => a.pid === target.pid);
const fullApp = byPid?.name || targetApp;
console.log(`   full app name by pid: ${fullApp}`);
const f = await call("find", { app: fullApp, window_id: String(targetWindowId), limit: 5 });
const fEnv = envelope(f);
check("find ok:true returns matches/refs", fEnv?.ok === true, text(f).slice(0, 200));
const fRefs = (text(f).match(/@[a-z0-9]+:e\d+/gi) || []);

// 4. cross-process ref lifetime: this find's ref must resolve in a *new* CLI process.
// Every server call already spawns a fresh process; drill with root_ref from the find result.
if (fRefs.length > 0) {
  // 4a. cross-process ref lifetime: every server call spawns a fresh CLI process,
  // so resolving this ref via `get` proves refs survive across processes.
  const g = spawnSync(process.env.AGENT_DESKTOP_BIN || "agent-desktop", ["get", fRefs[0]], { encoding: "utf8" });
  const line = g.stdout.split("\n").map((l) => l.trim()).filter(Boolean).pop() || "";
  let gOk = false;
  try { gOk = JSON.parse(line).ok === true; } catch {}
  check("refs survive across CLI processes (get @ref from find's ref)", gOk, line.slice(0, 200));

  // 4b. snapshot --root drill. Upstream bug: the CLI stores a 16-char-truncated app name,
  // so --root fails with APP_NOT_FOUND for apps with longer localized names. Use a genuinely short name.
  const candidates = windowList.filter((w) => w.accessible && w.visible && w.id && (w.app_name || "").length < 16);
  candidates.sort((x, y) => (x.app_name === "Kimi Code" ? -1 : y.app_name === "Kimi Code" ? 1 : 0));
  let drilled = false;
  for (const short of candidates.slice(0, 3)) {
    const a = spawnSync(process.env.AGENT_DESKTOP_BIN || "agent-desktop",
      ["snapshot", "--window-id", String(short.id), "-i", "--compact"], { encoding: "utf8" });
    let aRef = null;
    try {
      const j = JSON.parse(a.stdout.trim());
      const findRef = (n) => { if (!n) return null; if (n.ref_id) return n.ref_id; for (const c of n.children || []) { const r = findRef(c); if (r) return r; } return null; };
      aRef = findRef(j.data?.tree);
    } catch {}
    if (!aRef) continue;
    const b = spawnSync(process.env.AGENT_DESKTOP_BIN || "agent-desktop",
      ["snapshot", "--window-id", String(short.id), "--root", aRef, "-i", "--compact"], { encoding: "utf8" });
    let bOk = false;
    try { bOk = JSON.parse(b.stdout.trim()).ok === true; } catch {}
    check(`snapshot --root drill on short-named app (${short.app_name})`, bOk, b.stdout.slice(0, 200));
    drilled = true;
    break;
  }
  if (!drilled) console.log("SKIP --root drill: no candidate window produced refs");
} else {
  console.log("SKIP cross-process ref drill: find returned no refs");
}

child.kill("SIGTERM");
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
