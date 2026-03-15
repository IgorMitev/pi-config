import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "write_artifact",
    label: "Write Artifact",
    description:
      "Write a session-scoped artifact file (plan, context, research, notes, etc.). " +
      "Files are stored under ~/.pi/history/<project>/artifacts/<session-id>/. " +
      "Use this instead of writing pi working files directly.",
    promptGuidelines: [
      "Use write_artifact for any pi working file: plans, scout context, research notes, reviews, or other session artifacts.",
      "The name param can include subdirectories (e.g. 'context/auth-flow.md').",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Filename, e.g. 'plan.md' or 'context/auth-flow.md'" }),
      content: Type.String({ description: "File content" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const project = basename(ctx.cwd);
      const sessionId = ctx.sessionManager.getSessionId();
      const artifactDir = join(homedir(), ".pi", "history", project, "artifacts", sessionId);
      const filePath = resolve(artifactDir, params.name);

      // Safety: ensure we're not escaping the artifact directory
      if (!filePath.startsWith(artifactDir)) {
        throw new Error(`Path escapes artifact directory: ${params.name}`);
      }

      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, params.content, "utf-8");

      return {
        content: [{ type: "text", text: `Artifact written to: ${filePath}` }],
        details: { path: filePath, name: params.name, sessionId },
      };
    },
  });
}
