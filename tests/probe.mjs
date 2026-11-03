#!/usr/bin/env node
// Protocol probe for the agent-desktop MCP server.
// Speaks newline-delimited JSON-RPC to the server over stdio and asserts response shapes.
// Usage: node tests/probe.mjs   (works without AX permissions; live GUI checks are separate)
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

function request(method, params) {
  const id = nextId++;
  const line = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for response to ${method}`));
    }, 120000);
    pending.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    child.stdin.write(line + "\n");
  });
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id != null && pending.has(msg.id)) {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb(msg);
  }
});

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "probe", version: "0.0.1" },
  });
  check("initialize.protocolVersion === 2025-06-18", init.result?.protocolVersion === "2025-06-18", JSON.stringify(init).slice(0, 200));
  check("initialize.serverInfo.name === agent-desktop", init.result?.serverInfo?.name === "agent-desktop");
  check("initialize.capabilities.tools present", !!init.result?.capabilities?.tools);

  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await request("tools/list");
  const names = (list.result?.tools || []).map((t) => t.name);
  check("tools/list has >= 20 tools", names.length >= 20, `got ${names.length}`);
  for (const expected of ["get_app_state", "click", "type_text", "screenshot", "batch", "wait", "status"]) {
    check(`tools/list includes ${expected}`, names.includes(expected));
  }
  const schemaOk = list.result.tools.every((t) => t.inputSchema?.type === "object" && typeof t.description === "string");
  check("every tool has object inputSchema + description", schemaOk);

  // status runs even without AX permissions (it reports permission state).
  const status = await request("tools/call", { name: "status", arguments: {} });
  check("tools/call status returns content", Array.isArray(status.result?.content) && status.result.content.length > 0);
  check("tools/call status not isError", status.result?.isError !== true, JSON.stringify(status.result).slice(0, 300));
  const statusText = status.result?.content?.[0]?.text || "";
  check("status mentions permissions", /permissions/i.test(statusText));

  // error path: click with a bogus ref must surface a CLI error envelope, not crash.
  const badClick = await request("tools/call", { name: "click", arguments: { ref: "@deadbeef:e99" } });
  check("tools/call click(bogus ref) is isError", badClick.result?.isError === true, JSON.stringify(badClick.result).slice(0, 300));

  const unknown = await request("tools/call", { name: "no_such_tool", arguments: {} });
  check("unknown tool -> JSON-RPC error -32602", unknown.error?.code === -32602);
} finally {
  child.kill("SIGTERM");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
