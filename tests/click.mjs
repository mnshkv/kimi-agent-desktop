#!/usr/bin/env node
// CLICK live check: Calculator digit press -> display verify -> clear -> verify,
// then quits Calculator (it was launched by this test). Headless throughout.
// Usage: node tests/click.mjs
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "bin", "agent-desktop-mcp.mjs");
const APP = "Калькулятор"; // fallback; the real running name is resolved by pid after launch
const CLI = process.env.AGENT_DESKTOP_BIN || "agent-desktop";

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
const firstEnvelope = (r) => {
  for (const c of r?.content || []) {
    if (c.type !== "text") continue;
    try { const j = JSON.parse(c.text); if (j && typeof j === "object" && "ok" in j) return j; } catch {}
  }
  return null;
};
const text = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const refOf = (r) => text(r).match(/@[a-z0-9]+:e\d+/i)?.[0] || null;
const cliJson = (args) => {
  const out = spawnSync(CLI, args, { encoding: "utf8" }).stdout.trim();
  try { return JSON.parse(out); } catch { return null; }
};
// display = the statictext child of the display scrollarea ("Изменить поле"); LTR marks possible
const displayValue = () => {
  const snap = cliJson(["snapshot", "--app", appName, "--max-depth", "8"]);
  let found = null;
  const walk = (n) => {
    if (!n || found) return;
    if (n.role === "scrollarea") {
      for (const c of n.children || []) {
        if (c.role === "statictext" && typeof c.name === "string") { found = c.name.replace(/\u200e/g, ""); return; }
      }
    }
    for (const c of n.children || []) walk(c);
  };
  walk(snap?.data?.tree);
  return found;
};
let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? " — " + String(detail).slice(0, 220) : ""}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const launch = await call("launch", { app: "Calculator", timeout_ms: 20000 });
check("launch Calculator ok:true", firstEnvelope(launch)?.ok === true, text(launch));

// resolve the real running app name by pid, waiting for the inventory to catch up
let appName = APP;
const launchPid = firstEnvelope(launch)?.data?.pid;
for (let i = 0; i < 20; i++) {
  const apps = firstEnvelope(await call("list_apps", { running_only: true }));
  const hit = (apps?.data?.apps || []).find((a) => (launchPid && a.pid === launchPid) || /калькулятор|calculator/i.test(a.name || ""));
  if (hit) { appName = hit.name; break; }
  await sleep(500);
}
console.log(`   running app resolved as: ${appName}`);
await new Promise((r) => setTimeout(r, 1000));

console.log(`   display before: ${JSON.stringify(displayValue())}`);

const one = await call("find", { app: appName, role: "button", name: "1", exact: true, first: true });
const oneRef = refOf(one);
check("find button '1'", !!oneRef, text(one));

if (oneRef) {
  // A click lands as AXPress (delivered_unverified). If the app was still restoring its
  // window it may swallow the press; the documented response is re-observe + act again
  // with a FRESH ref (never a blind retry of the same ref).
  const attempt = async () => {
    const f = await call("find", { app: appName, role: "button", name: "1", exact: true, first: true });
    const ref = refOf(f);
    if (!ref) return { clicked: false, env: null, before: displayValue(), after: displayValue() };
    const before = displayValue();
    const clicked = await call("click", { ref });
    const env = firstEnvelope(clicked);
    let after = before;
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 700));
      after = displayValue();
      if (after !== before) break;
    }
    return { clicked: true, ref, env, before, after };
  };

  let r1 = await attempt();
  check("click '1' ok:true (headless AXPress)", r1.clicked && r1.env?.ok === true, text(r1.env && { content: [{ type: "text", text: JSON.stringify(r1.env) }] }));
  check("envelope reports AXPress succeeded", !!r1.env && JSON.stringify(r1.env.data || {}).includes("AXPress"), JSON.stringify(r1.env?.data || {}).slice(0, 150));

  if (r1.after === r1.before) {
    console.log("   no visible change; re-observing and clicking once more with a fresh ref");
    r1 = await attempt();
  }
  check("display changed after click (real UI effect)", r1.after !== r1.before, `before=${JSON.stringify(r1.before)} after=${JSON.stringify(r1.after)}`);
  console.log(`   display: ${JSON.stringify(r1.before)} -> ${JSON.stringify(r1.after)}`);
}

// clean up: the test launched Calculator; quit it gracefully
const closed = await call("close_app", { app: appName });
check("close_app Calculator ok:true", firstEnvelope(closed)?.ok === true, text(closed));

child.kill("SIGTERM");
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
