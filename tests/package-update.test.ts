import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handlePackageCommand } from "../install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/package-manager-cli.js";
import { DefaultPackageManager } from "../install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js";

// Exercise the installed command parser, trust handling and reconciliation. Stub
// only the external git installation boundary; never run git/npm or providers.
test("installed update --extensions --no-approve installs missing configured git packages without rewriting filters and propagates failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-package-update-"));
  const previousCwd = process.cwd();
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousExitCode = process.exitCode;
  const originalInstallGit = DefaultPackageManager.prototype.installGit;
  const calls: any[] = [];
  try {
    const agent = join(dir, "agent");
    const project = join(dir, "project");
    mkdirSync(agent);
    mkdirSync(join(project, ".pi"), { recursive: true });
    const settings = JSON.stringify({ packages: [{ source: "git:github.com/example/configured", extensions: ["-extensions/excluded.ts"], skills: [] }] }, null, 2) + "\n";
    writeFileSync(join(agent, "settings.json"), settings);
    const local = JSON.stringify({ packages: ["git:github.com/example/untrusted"] });
    writeFileSync(join(project, ".pi", "settings.json"), local);
    process.env.PI_CODING_AGENT_DIR = agent;
    process.chdir(project);
    let fail = false;
    DefaultPackageManager.prototype.installGit = async function (source: any, scope: any) {
      calls.push([source, scope]);
      if (fail) throw new Error("Mock git install failure");
    };
    process.exitCode = 0;
    assert.equal(await handlePackageCommand(["update", "--extensions", "--no-approve"]), true);
    assert.equal(process.exitCode, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], "user");
    assert.match(JSON.stringify(calls[0][0]), /configured/);
    assert.equal(readFileSync(join(agent, "settings.json"), "utf8"), settings);
    assert.equal(readFileSync(join(project, ".pi", "settings.json"), "utf8"), local);
    fail = true;
    assert.equal(await handlePackageCommand(["update", "--extensions", "--no-approve"]), true);
    assert.equal(process.exitCode, 1);
    assert.equal(calls.length, 2);
    assert.equal(readFileSync(join(agent, "settings.json"), "utf8"), settings);
  } finally {
    DefaultPackageManager.prototype.installGit = originalInstallGit;
    process.chdir(previousCwd);
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    process.exitCode = previousExitCode;
    rmSync(dir, { recursive: true, force: true });
  }
});
