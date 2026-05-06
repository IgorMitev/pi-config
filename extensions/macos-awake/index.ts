import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";

const CAFFEINATE_ARGS = ["-ims"];

export default function macosAwake(pi: ExtensionAPI) {
  let caffeinate: ChildProcess | undefined;

  function isRunning() {
    return caffeinate !== undefined && caffeinate.exitCode === null && !caffeinate.killed;
  }

  function start() {
    if (process.platform !== "darwin") return false;
    if (isRunning()) return true;

    caffeinate = spawn("/usr/bin/caffeinate", CAFFEINATE_ARGS, {
      stdio: "ignore",
      detached: false,
    });

    caffeinate.once("exit", () => {
      caffeinate = undefined;
    });

    caffeinate.once("error", () => {
      caffeinate = undefined;
    });

    return true;
  }

  function stop() {
    if (!isRunning()) {
      caffeinate = undefined;
      return false;
    }

    caffeinate.kill();
    caffeinate = undefined;
    return true;
  }

  pi.on("agent_start", async () => {
    start();
  });

  pi.on("agent_end", async () => {
    stop();
  });

  pi.on("session_shutdown", async () => {
    stop();
  });

  pi.registerCommand("awake-status", {
    description: "Show whether the macOS idle-sleep prevention assertion is active for the current Pi task.",
    handler: async (_args, ctx) => {
      if (process.platform !== "darwin") {
        ctx.ui.notify("macOS awake extension is inactive on this platform.", "info");
        return;
      }

      ctx.ui.notify(
        isRunning()
          ? `macOS idle-sleep prevention active: caffeinate ${CAFFEINATE_ARGS.join(" ")}. Display sleep and explicit Sleep still work.`
          : "macOS idle-sleep prevention inactive; it only runs while Pi is processing a task.",
        "info",
      );
    },
  });
}
