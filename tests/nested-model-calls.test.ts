import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadExtensions } from "../install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { initTheme } from "../install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { Check } from "../install/releases/1.4.0/node_modules/typebox/build/value/index.mjs";

initTheme("dark", false);

const root = fileURLToPath(new URL("../", import.meta.url));
async function load(path: string) {
  const result = await loadExtensions([root + path], root);
  assert.deepEqual(result.errors, []);
  return { ...result, extension: result.extensions[0] };
}
const current = { provider: "custom", id: "current" };
const mini = { provider: "openai", id: "gpt-5.4-mini" };
const response = (text: string, stopReason = "stop") => ({ stopReason, content: [{ type: "text", text }] });

// Only modelRegistry is mocked: real installed loader, aliases, schemas and UI components.
// No runtime/auth store is constructed and no provider is contacted.
async function answerHarness(options: any = {}) {
  const loaded = await load("extensions/answer/index.ts");
  const calls: any[] = [], notices: any[] = [], sent: any[] = [], components: any[] = [];
  const ctx: any = {
    hasUI: true,
    model: current,
    sessionManager: { getBranch: () => [{ type: "message", message: {
      role: "assistant", stopReason: options.branchStop ?? "toolUse",
      content: [{ type: "text", text: "Which database?" }, { type: "toolCall", name: "execute_command" }],
    } }] },
    modelRegistry: {
      find: (provider: string, id: string) => {
        assert.equal(provider, "openai"); assert.equal(id, mini.id);
        return options.missingMini ? undefined : mini;
      },
      getApiKeyAndHeaders: async (model: any) => {
        assert.equal(model, mini);
        return options.noAuth ? { ok: false, error: "Unavailable" } : { ok: true, apiKey: "mock-selection-only", headers: { "X-Test": "selection-only" } };
      },
      complete: async (...args: any[]) => {
        calls.push(args);
        if (options.fail) throw new Error("mock failure");
        if (options.abort) {
          assert.equal(args[2].signal.aborted, true);
          return response("", "aborted");
        }
        return response(options.text ?? '```json\n{"questions":[{"question":"Which database?","context":"(a) SQL, (b) Other"}]}\n```');
      },
    },
    ui: {
      notify: (...args: any[]) => notices.push(args),
      custom: async (factory: any) => {
        let component: any;
        const result = new Promise((resolve) => {
          component = factory({ requestRender() {}, terminal: { rows: 24 } }, { fg: (_: any, text: string) => text }, {}, resolve);
          components.push(component);
          if (components.length === 1 && options.abort) component.handleInput("\x1b");
          if (components.length === 2) {
            component.handleInput("PostgreSQL");
            component.handleInput("\r");
            component.handleInput("\r");
          }
        });
        try { return await result; } finally { component?.dispose?.(); }
      },
    },
  };
  loaded.runtime.sendMessage = (...args: any[]) => sent.push(args);
  await loaded.extension.commands.get("answer")!.handler("", ctx);
  return { calls, notices, sent, components };
}

test("answer uses registry completion with Mini, loader cancellation, and unchanged extraction/submission", async () => {
  const h = await answerHarness();
  assert.equal(h.calls.length, 1);
  const [model, context, opts] = h.calls[0];
  assert.equal(model, mini);
  assert.match(context.systemPrompt, /preserve them EXACTLY/);
  assert.deepEqual(context.messages[0].content, [{ type: "text", text: "Which database?" }]);
  assert.deepEqual(Object.keys(opts), ["signal"]); // Registry resolves request auth, not a stale explicit snapshot.
  assert.equal(opts.signal, h.components[0].signal);
  assert.match(h.sent[0][0].content, /Q: Which database\?[\s\S]*\(a\) SQL[\s\S]*A: PostgreSQL/);
  assert.deepEqual(h.sent[0][1], { triggerTurn: true });
});

test("answer falls back to current model when Mini is absent or unauthenticated", async () => {
  for (const options of [{ missingMini: true }, { noAuth: true }]) {
    const h = await answerHarness({ ...options, text: '{"questions":[]}' });
    assert.equal(h.calls[0][0], current);
    assert.deepEqual(h.notices, [["No questions found in the last message", "info"]]);
    assert.deepEqual(h.sent, []);
  }
});

test("answer preserves cancellation, parse errors, exceptions and incomplete-message guards", async () => {
  for (const options of [{ abort: true }, { fail: true }, { text: "not json" }]) {
    const h = await answerHarness(options);
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.notices, [["Cancelled", "info"]]);
  }
  const h = await answerHarness({ branchStop: "error" });
  assert.equal(h.calls.length, 0);
  assert.match(h.notices[0][0], /incomplete/);
});

test("modern local imports load and todo retains a flat, validated string enum", async () => {
  for (const name of ["answer", "cmux", "cost", "execute-command", "macos-awake", "thinking-level", "tavily", "todos"]) {
    const loaded = await load(`extensions/${name}/index.ts`);
    if (name !== "todos") continue;
    const schema = loaded.extension.tools.get("todo")!.definition.parameters;
    assert.equal(schema.properties.action.type, "string");
    assert.deepEqual(schema.properties.action.enum, ["list", "list-all", "get", "create", "update", "append", "delete", "claim", "release"]);
    assert.equal(Check(schema, { action: "claim", id: "TODO-deadbeef" }), true);
    assert.equal(Check(schema, { action: "invalid" }), false);
  }
});
