import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AgentSession } from "../install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js";
import { loadExtensions } from "../install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { createEventBus } from "../install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";

// Use the installed loader (including legacy import aliases) and the real prompt /
// settlement dispatch, without constructing a model, reading credentials, or starting a TUI.
async function harness(hasUI = true) {
  const bus = createEventBus();
  const loaded = await loadExtensions(
    [fileURLToPath(new URL("../extensions/execute-command/index.ts", import.meta.url))],
    fileURLToPath(new URL("../", import.meta.url)),
    bus,
  );
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const session: any = Object.create(AgentSession.prototype);
  const calls: any[] = [];
  const errors: any[] = [];
  const notifications: any[] = [];
  const editor: string[] = [];
  const eventContext = { hasUI, ui: {}, marker: "lifecycle context" };
  const commandContext = {
    hasUI,
    marker: "fresh command context",
    ui: {
      setEditorText: (text: string) => editor.push(text),
      notify: (...args: any[]) => notifications.push(args),
    },
    reload: async () => {
      assert.equal(session._isEmittingAgentSettled, false);
      assert.equal(session.isIdle, true);
      calls.push("reload");
      await emit("session_shutdown", { reason: "reload" });
      loaded.runtime.invalidate();
    },
  };
  const emit = async (type: string, event = {}) => {
    for (const handler of extension.handlers.get(type) ?? []) {
      await handler({ type, ...event }, eventContext as any);
    }
  };
  Object.assign(session, {
    _isAgentRunActive: true,
    _isEmittingAgentSettled: false,
    _agentRunAbortRequested: false,
    _deferredSettledActions: [],
    _eventListeners: [],
    _extensionRunner: {
      emit: async (event: any) => emit(event.type, event),
      getCommand: (name: string) => extension.commands.get(name),
      createCommandContext: () => commandContext,
      emitError: (error: any) => errors.push(error),
    },
  });
  const sends: any[] = [];
  loaded.runtime.sendUserMessage = (content: any, options: any) => {
    sends.push([content, options]);
    // Same fire-and-forget bridge as AgentSession._bindExtensionCore.
    void session.sendUserMessage(content, options).catch((error: any) => errors.push(error));
  };
  bus.on("trigger:answer", (ctx: any) => {
    assert.equal(session._isEmittingAgentSettled, false);
    assert.equal(session.isIdle, true);
    calls.push(["answer", ctx]);
  });
  return {
    session, extension, emit, sends, calls, errors, notifications, editor, commandContext,
    queue: (command: string, reason?: string) =>
      extension.tools.get("execute_command")!.definition.execute("test", { command, reason }, undefined, undefined, eventContext as any),
    settle: () => session._emitAgentSettled(),
  };
}

test("defers across retry / continuation runs and emits answer with a fresh command context", async () => {
  const h = await harness();
  const result = await h.queue("/answer", "Collect answers");
  assert.deepEqual(result.details, { command: "/answer", reason: "Collect answers", queued: true });
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
  await h.emit("agent_start");
  await h.emit("agent_end");
  await h.emit("agent_before_settle");
  await h.emit("agent_start");
  await h.emit("agent_end");
  assert.deepEqual(h.sends, []);
  assert.deepEqual(h.calls, []);
  // Later settlement observers finish before the interactive answer event fires.
  h.extension.handlers.get("agent_settled")!.push(async () => {
    assert.equal(h.sends.length, 1);
    assert.deepEqual(h.calls, []);
    await Promise.resolve();
    assert.deepEqual(h.calls, []);
  });
  await h.settle();
  assert.deepEqual(h.calls, [["answer", h.commandContext]]);
  h.extension.handlers.get("agent_settled")!.pop();
  await h.settle();
  assert.equal(h.sends.length, 1);
  assert.deepEqual(h.errors, []);
});

test("slash requests dispatch extension commands with arguments, not literal model input", async () => {
  const h = await harness();
  h.extension.commands.set("example", {
    name: "example",
    description: "Test command",
    handler: async (args: string, ctx: any) => {
      assert.equal(h.session._isEmittingAgentSettled, false);
      h.calls.push([args, ctx]);
    },
  } as any);
  await h.queue("/example some arguments");
  await h.settle();
  assert.deepEqual(h.calls, [["some arguments", h.commandContext]]);
  assert.equal(h.sends.length, 2);
  assert.deepEqual(h.sends[1], ["/example some arguments", { expandPromptTemplates: true }]);
  assert.deepEqual(h.errors, []);
});

test("reload uses command-only reload after settlement and never reuses the stale runtime", async () => {
  const h = await harness();
  await h.queue("/reload");
  await h.settle();
  assert.deepEqual(h.calls, ["reload"]);
  assert.equal(h.sends.length, 1);
  assert.deepEqual(h.errors, []);
  await h.emit("agent_settled");
  assert.equal(h.sends.length, 1);
});

test("shutdown drops pending work, including handoffs already deferred during settlement", async () => {
  const h = await harness();
  await h.queue("/answer");
  await h.emit("session_shutdown", { reason: "switch" });
  await h.settle();
  assert.deepEqual(h.sends, []);
  await h.queue("/answer");
  h.extension.handlers.get("agent_settled")!.push(async () => {
    await h.emit("session_shutdown", { reason: "reload" });
  });
  await h.settle();
  assert.equal(h.sends.length, 1);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.errors, []);
});

test("stale handoffs cannot consume newer requests and last queued request still wins", async () => {
  const h = await harness();
  await h.queue("/reload");
  await h.queue("old text");
  h.extension.handlers.get("agent_settled")!.push(async () => {
    await h.emit("session_shutdown", { reason: "switch" });
    await h.queue("new text");
  });
  await h.settle();
  assert.deepEqual(h.editor, []);
  h.extension.handlers.get("agent_settled")!.pop();
  await h.settle();
  assert.deepEqual(h.editor, ["new text"]);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.errors, []);
});

test("a handoff from a replaced runtime cannot dispatch the new runtime's pending request", async () => {
  const old = await harness();
  await old.queue("/answer");
  old.extension.handlers.get("agent_settled")!.push(() => old.emit("session_shutdown", { reason: "reload" }));
  await old.settle();
  const replacement = await harness();
  await replacement.queue("/answer");
  await replacement.session.sendUserMessage(...old.sends[0]);
  assert.deepEqual(replacement.calls, []);
  await replacement.settle();
  assert.deepEqual(replacement.calls, [["answer", replacement.commandContext]]);
  assert.deepEqual(replacement.errors, []);
});

test("plain text only prefills and notifies, including after an aborted run", async () => {
  const h = await harness();
  await h.queue("follow-up text");
  await h.emit("agent_end");
  assert.deepEqual(h.editor, []);
  h.session._agentRunAbortRequested = true;
  await h.settle();
  assert.deepEqual(h.editor, ["follow-up text"]);
  assert.deepEqual(h.notifications, [["Press Enter to send: follow-up text", "info"]]);
  assert.equal(h.sends.length, 1); // Only the dispatcher, never a model prompt.
  assert.deepEqual(h.errors, []);
  const headless = await harness(false);
  await headless.queue("text without UI");
  await headless.settle();
  assert.deepEqual(headless.editor, []);
  assert.deepEqual(headless.notifications, []);
  assert.deepEqual(headless.errors, []);
});
