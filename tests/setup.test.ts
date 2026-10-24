import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

const packages = [
  "git:github.com/pasky/chrome-cdp-skill",
  "git:github.com/HazAT/glimpse",
  "git:github.com/IgorMitev/pi-interactive-subagents@351e280aa0964a3e487604862b1507882109683d",
  {
    source: "git:github.com/HazAT/pi-autoresearch",
    extensions: ["-extensions/pi-autoresearch/index.ts"],
    skills: [],
  },
  "git:https://github.com/badlogic/pi-diff-review",
];

function fixture(t: TestContext, settings?: string) {
  const home = mkdtempSync(join(tmpdir(), "pi-setup-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const agentDir = join(home, ".pi", "agent");
  const binDir = join(home, "bin");
  const log = join(home, "pi-call.json");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(binDir);
  copyFileSync(new URL("../setup.sh", import.meta.url), join(agentDir, "setup.sh"));
  if (settings !== undefined) writeFileSync(join(agentDir, "settings.json"), settings);
  // Only the non-persisting reconciliation command is allowed. No real Pi,
  // credentials, package installs, or network requests are involved.
  writeFileSync(join(binDir, "pi"), `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const settings = fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), "utf8");
fs.writeFileSync(process.env.SETUP_TEST_LOG, JSON.stringify({ args, settings, agentDir: process.env.PI_CODING_AGENT_DIR }));
if (JSON.stringify(args) !== JSON.stringify(["update", "--extensions", "--no-approve"])) {
  console.error("Unexpected package command (may mutate settings)");
  process.exit(90);
}
if (process.env.SETUP_TEST_FAIL === "1") {
  console.error("simulated package dependency install failure");
  process.exit(23);
}
`, { mode: 0o755 });
  return {
    agentDir,
    settings: () => readFileSync(join(agentDir, "settings.json"), "utf8"),
    call: () => JSON.parse(readFileSync(log, "utf8")),
    run: (fail = false, misplaced = false) => spawnSync("/bin/bash", [join(agentDir, "setup.sh")], {
      cwd: home,
      encoding: "utf8",
      env: {
        HOME: misplaced ? join(home, "other") : home,
        PATH: `${binDir}:/usr/bin:/bin`,
        // A parent session's override must not redirect setup to live settings.
        PI_CODING_AGENT_DIR: join(home, "wrong-agent-dir"),
        SETUP_TEST_LOG: log,
        SETUP_TEST_FAIL: fail ? "1" : "0",
      },
    }),
  };
}

test("setup creates aligned defaults and reconciles only configured packages", (t) => {
  const h = fixture(t);
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  const settings = JSON.parse(h.settings());
  assert.deepEqual(settings, {
    defaultProvider: "openai",
    defaultModel: "gpt-6.1-sol",
    defaultThinkingLevel: "medium",
    packages,
    hideThinkingBlock: true,
    extensions: ["+extensions/cmux/index.ts"],
    theme: "everforest",
  });
  assert.deepEqual(h.call(), {
    args: ["update", "--extensions", "--no-approve"],
    settings: h.settings(),
    agentDir: h.agentDir,
  });
  assert.match(result.stdout, /Setup complete/);
});

test("setup preserves existing settings and package filters byte-for-byte on repeated runs", (t) => {
  const existing = JSON.stringify({
    defaultProvider: "custom",
    theme: "custom-theme",
    packages: [
      ...packages,
      { source: "git:github.com/example/custom", extensions: [], skills: ["+skills/custom/SKILL.md"] },
    ],
    customSetting: { keep: true },
  }, null, 4) + "\n";
  const h = fixture(t, existing);
  for (let i = 0; i < 2; i++) {
    const result = h.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(h.settings(), existing);
    assert.equal(h.call().settings, existing);
    assert.match(result.stdout, /skipping creation/);
  }
});

for (const existing of [undefined, '{ "packages": [], "theme": "custom" }\n']) {
  test(`setup exposes package failures with ${existing === undefined ? "missing" : "existing"} settings`, (t) => {
    const h = fixture(t, existing);
    const result = h.run(true);
    assert.equal(result.status, 23);
    assert.match(result.stderr, /simulated package dependency install failure/);
    assert.doesNotMatch(result.stdout, /Setup complete|already installed/);
    if (existing !== undefined) assert.equal(h.settings(), existing);
    else assert.deepEqual(JSON.parse(h.settings()).packages, packages);
  });
}

test("setup refuses an unexpected clone location before invoking Pi", (t) => {
  const h = fixture(t);
  const result = h.run(false, true);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /This repo should be cloned/);
  assert.throws(h.call, { code: "ENOENT" });
  assert.throws(h.settings, { code: "ENOENT" });
});
