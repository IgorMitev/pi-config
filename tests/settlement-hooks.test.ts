import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import macosAwake from "../extensions/macos-awake/index.ts";

function harness() {
  const handlers = new Map<string, Function>();
  const commands: string[][] = [];
  const ctx = {
    hasUI: true,
    sessionManager: { getBranch: () => [] },
    getContextUsage: () => ({ tokens: 1234 }),
  };
  const pi = {
    on: (event: string, handler: Function) => handlers.set(event, handler),
    exec: async (_command: string, args: string[]) => { commands.push(args); },
    getThinkingLevel: () => "off",
    registerCommand: () => {},
  };
  return {
    pi: pi as any,
    commands,
    emit: async (event: string, payload = {}) => handlers.get(event)?.(payload, ctx),
  };
}

test("cmux stays working across retries and notifies only at settlement", async () => {
  const previousSocket = process.env.CMUX_SOCKET_PATH;
  process.env.CMUX_SOCKET_PATH = "/test/cmux.sock";
  try {
    const { default: cmux } = await import("../extensions/cmux/index.ts");
    const h = harness();
    cmux(h.pi);
    await h.emit("session_start");
    h.commands.length = 0;
    await h.emit("agent_start");
    await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
    assert.equal(h.commands.some((args) => args[0] === "notify"), false);
    assert.equal(h.commands.some((args) => args[2] === "Idle"), false);
    await h.emit("agent_start");
    await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
    assert.equal(h.commands.some((args) => args[0] === "notify"), false);
    await h.emit("agent_settled", { aborted: false });
    assert.equal(h.commands.filter((args) => args[0] === "notify").length, 1);
    assert.ok(h.commands.some((args) => args[1] === "pi_state" && args[2] === "Idle"));
    assert.ok(h.commands.some((args) => args[0] === "clear-status" && args[1] === "pi_tool"));
    assert.ok(h.commands.some((args) => args[1] === "pi_tokens" && args[2] === "1.2k"));
    h.commands.length = 0;
    await h.emit("session_shutdown");
    assert.equal(h.commands.filter((args) => args[0] === "clear-status").length, 6);
  } finally {
    if (previousSocket === undefined) delete process.env.CMUX_SOCKET_PATH;
    else process.env.CMUX_SOCKET_PATH = previousSocket;
  }
});

test("awake retains one assertion until settlement and cleans up on shutdown", async (t) => {
  // Exercise the macOS path without launching caffeinate, on any host platform.
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin" });
  const children: any[] = [];
  const spawn = t.mock.method(childProcess, "spawn", () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      killed: false,
      kill() { this.killed = true; return true; },
    });
    children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  try {
    const h = harness();
    macosAwake(h.pi);
    await h.emit("agent_start");
    await h.emit("agent_end");
    assert.equal(children[0].killed, false);
    await h.emit("agent_start");
    assert.equal(spawn.mock.callCount(), 1);
    await h.emit("agent_settled", { aborted: false });
    assert.equal(children[0].killed, true);
    await h.emit("agent_start");
    await h.emit("agent_settled", { aborted: true });
    assert.equal(children[1].killed, true);
    await h.emit("agent_start");
    await h.emit("session_shutdown");
    assert.equal(children[2].killed, true);
    await h.emit("session_shutdown");
    assert.equal(spawn.mock.callCount(), 3);
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
  }
});
