import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { loadExtensions } from "../install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { createEventBus } from "../install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";

async function harness(t: TestContext, autoExit: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-completion-"));
  const session = join(dir, "session.jsonl");
  const env = {
    PI_SUBAGENT_AUTO_EXIT: autoExit ? "1" : "0",
    PI_SUBAGENT_SESSION: session,
    PI_SUBAGENT_ID: "completion-test",
    PI_SUBAGENT_ACTIVITY_FILE: join(dir, "activity.json"),
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const loaded = await loadExtensions(
    [fileURLToPath(new URL("../git/github.com/IgorMitev/pi-interactive-subagents/pi-extension/subagents/subagent-done.ts", import.meta.url))],
    fileURLToPath(new URL("../", import.meta.url)),
    createEventBus(),
  );
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  let shutdowns = 0;
  const ctx = { ui: { setWidget() {} }, shutdown() { shutdowns++; } };
  return {
    extension,
    shutdowns: () => shutdowns,
    exit: () => existsSync(`${session}.exit`) ? JSON.parse(readFileSync(`${session}.exit`, "utf8")) : null,
    emit: async (type: string, payload = {}) => {
      for (const handler of extension.handlers.get(type) ?? []) {
        await handler({ type, ...payload } as any, ctx as any);
      }
    },
    tool: (name: string, params = {}) => extension.tools.get(name)!.definition.execute("test", params, undefined, undefined, ctx as any),
  };
}

test("auto-exit agents cannot signal done early and shut down only at settlement", async t => {
  const h = await harness(t, true);
  assert.equal(h.extension.tools.has("subagent_done"), false);
  assert.equal(h.extension.tools.has("caller_ping"), true);
  await h.emit("agent_start");
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Test completed." }] }] });
  assert.equal(h.shutdowns(), 0);
  assert.equal(h.exit(), null);
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.shutdowns(), 1);
});

test("interactive agents retain explicit completion", async t => {
  const h = await harness(t, false);
  assert.equal(h.extension.tools.has("subagent_done"), true);
  await h.emit("agent_start");
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.shutdowns(), 0);
  await h.tool("subagent_done");
  assert.equal(h.shutdowns(), 1);
  assert.deepEqual(h.exit(), { type: "done" });
});

test("auto-exit agents can still request help via caller_ping", async t => {
  const h = await harness(t, true);
  await h.tool("caller_ping", { message: "Need clarification" });
  assert.equal(h.shutdowns(), 1);
  assert.equal(h.exit().type, "ping");
  assert.equal(h.exit().message, "Need clarification");
});
