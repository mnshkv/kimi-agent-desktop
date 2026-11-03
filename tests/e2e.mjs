#!/usr/bin/env node
// End-to-end smoke over the real MCP server process using tools that work
// without (or report the absence of) macOS permissions.
// Usage: node tests/e2e.mjs
import { spawn } from "node:child_process";
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
const imageBlocks = (r) => (r?.content || []).filter((c) => c.type === "image");
let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? " — " + String(detail).slice(0, 300) : ""}`); }
};

// 1. list_apps: envelope with ok:true and an apps array
const apps = await call("list_apps", { running_only: true });
const appsJson = JSON.parse(text(apps));
check("list_apps ok:true", appsJson.ok === true, text(apps));
check("list_apps has data.apps array", Array.isArray(appsJson.data?.apps));
console.log(`   apps found: ${appsJson.data?.apps?.length}`);

// 2. list_windows: may need AX or may work via CGWindowList; only assert a well-formed envelope
const wins = await call("list_windows", {});
const winsJson = JSON.parse(text(wins));
check("list_windows well-formed envelope", typeof winsJson.ok === "boolean", text(wins).slice(0, 200));

// 3. clipboard roundtrip
await call("clipboard_set", { text: "agent-desktop-e2e-42" });
const clip = await call("clipboard_get", {});
const clipJson = JSON.parse(text(clip));
check("clipboard roundtrip", clipJson.ok === true && String(clipJson.data?.text ?? clipJson.data?.content ?? "").includes("agent-desktop-e2e-42"), text(clip).slice(0, 300));

// 4. wait 300ms
const w = await call("wait", { ms: 300 });
check("wait ms ok:true", JSON.parse(text(w)).ok === true, text(w));

// 5. permission-gated tools must fail cleanly with a CLI error (or succeed if permissions were granted meanwhile)
const knownError = /PERM_DENIED|WINDOW_NOT_FOUND|NOT_FOUND|STALE_REF|INVALID_|AMBIGUOUS_TARGET/;
const snap = await call("get_app_state", { app: "Finder", mode: "ax" });
if (snap?.isError !== true) {
  const snapJson = JSON.parse(text(snap));
  check("get_app_state ok:true (permissions already granted)", typeof snapJson.data?.tree === "object");
} else {
  check("get_app_state gated -> clean CLI error", knownError.test(text(snap)), text(snap));
}

const shot = await call("screenshot", { app: "Finder" });
if (imageBlocks(shot).length > 0) {
  check("screenshot returns image block (permissions granted)", imageBlocks(shot)[0].mimeType === "image/png");
} else {
  check("screenshot gated -> clean CLI error", shot?.isError === true && knownError.test(text(shot)), text(shot));
}

// 6. batch: well-formed envelope (contents depend on permissions)
const b = await call("batch", { commands: [{ command: "list-apps", args: [] }], stop_on_error: true });
let bOk = false;
try { bOk = JSON.parse(text(b)).ok === true; } catch { bOk = false; }
check("batch ok:true", bOk || b?.isError === true, text(b).slice(0, 200));

child.kill("SIGTERM");
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
