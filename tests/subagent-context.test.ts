import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadExtensions } from "../install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { createEventBus } from "../install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";

async function harness(env: Record<string, string | undefined>) {
  const original = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const loaded = await loadExtensions(
      [fileURLToPath(new URL("../git/github.com/IgorMitev/pi-interactive-subagents/pi-extension/subagents/index.ts", import.meta.url))],
      fileURLToPath(new URL("../", import.meta.url)),
      createEventBus(),
    );
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions[0];
    const messages: any[] = [];
    loaded.runtime.sendMessage = (message: any, options: any) => messages.push({ message, options });
    for (const handler of extension.handlers.get("session_start") ?? []) {
      await handler({ type: "session_start" } as any, { hasUI: false } as any);
    }
    return { extension, messages };
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("subagent tool explains completion requirements in both model-facing descriptions", async () => {
  const { extension } = await harness({ HERDR_ENV: undefined, PI_DENY_TOOLS: undefined });
  const tool = extension.tools.get("subagent")!.definition;
  for (const text of [tool.description, tool.promptSnippet]) {
    assert.match(text!, /auto-exit: true/);
    assert.match(text!, /Bare launches default to interactive and require subagent_done/);
    assert.match(text!, /final reply alone does not notify the parent/);
    assert.match(text!, /Never prohibit subagent_done/);
    assert.match(text!, /interactive: false only controls status notifications, not auto-exit/);
  }
  assert.match((tool.parameters as any).properties.interactive.description, /does not enable auto-exit/);
});

test("Herdr startup supplies caller IDs without starting a turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-context-"));
  // Backend detection only checks command availability; no live socket is used.
  writeFileSync(join(dir, "herdr"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  let messages: any[];
  try {
    ({ messages } = await harness({
      HERDR_ENV: "1", HERDR_SOCKET_PATH: "/test/herdr.sock",
      HERDR_WORKSPACE_ID: "w7", HERDR_TAB_ID: "w7:t1", HERDR_PANE_ID: "w7:p1",
      PI_SUBAGENT_MUX: "herdr", PATH: `${dir}:${process.env.PATH ?? ""}`,
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(messages.length, 1);
  const { message, options } = messages[0];
  assert.equal(message.customType, "terminal_context");
  assert.equal(message.display, false);
  assert.equal(options.triggerTurn, false);
  assert.deepEqual(message.details, { backend: "herdr", workspace: "w7", tab: "w7:t1", pane: "w7:p1" });
  assert.match(message.content, /Current terminal host: Herdr/);
  assert.match(message.content, /not child panes/);
});

test("Herdr startup reports unavailable backends and missing IDs honestly", async () => {
  const { messages } = await harness({
    HERDR_ENV: "1", HERDR_SOCKET_PATH: undefined,
    HERDR_WORKSPACE_ID: undefined, HERDR_TAB_ID: undefined, HERDR_PANE_ID: undefined,
    PI_SUBAGENT_MUX: "herdr",
  });
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].message.details, { backend: null, workspace: "unknown", tab: "unknown", pane: "unknown" });
  assert.match(messages[0].message.content, /backend: unavailable/);
});

test("non-Herdr sessions do not receive Herdr context", async () => {
  const { messages } = await harness({ HERDR_ENV: undefined });
  assert.deepEqual(messages, []);
});
