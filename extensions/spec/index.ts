import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const workflowPath = join(extensionDirectory, "workflow.md");

export default function (pi: ExtensionAPI) {
  pi.registerCommand("spec", {
    description: "Define what to build, then plan how to build it: /spec <request>",
    handler: async (args, ctx) => {
      const request = args.trim();
      if (!request) {
        ctx.ui.notify("Usage: /spec <what to build>", "warning");
        return;
      }

      const workflow = readFileSync(workflowPath, "utf8");
      pi.sendUserMessage(
        `<skill name="spec-workflow" location="${workflowPath}">\n${workflow.trim()}\n</skill>\n\n${request}`,
      );
    },
  });
}
