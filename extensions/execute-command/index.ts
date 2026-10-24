import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";

export default function (pi: ExtensionAPI) {
  // Keep the existing last-command-wins behavior until automatic processing settles.
  let pendingCommand: { command: string; reason?: string; id: string; scheduled: boolean } | null = null;

  pi.registerCommand("execute-command-dispatch", {
    description: "Dispatch the pending execute_command request",
    handler: async (id, ctx) => {
      if (!pendingCommand || pendingCommand.id !== id) return;
      const { command } = pendingCommand;
      pendingCommand = null;

      if (command === "/answer") {
        pi.events.emit("trigger:answer", ctx);
      } else if (command === "/reload") {
        // Reload replaces this runtime; do not use pi or ctx afterward.
        await ctx.reload();
        return;
      } else if (command.startsWith("/")) {
        pi.sendUserMessage(command, { expandPromptTemplates: true });
      } else if (ctx.hasUI) {
        ctx.ui.setEditorText(command);
        ctx.ui.notify(`Press Enter to send: ${command}`, "info");
      }
    },
  });

  pi.on("session_shutdown", () => {
    pendingCommand = null;
  });

  // Tool to execute a command/message directly (self-invoke)
  pi.registerTool({
    name: "execute_command",
    label: "Execute Command",
    description: `Execute a slash command or send a message as if the user typed it. The message is added to the session history and triggers a new turn. Use this to:
- Self-invoke /answer after asking multiple questions
- Run /reload after creating skills
- Execute any slash command programmatically
- Send follow-up prompts to yourself

The command/message appears in the conversation as a user message.`,
    promptSnippet:
      "Execute a slash command or send a message as if the user typed it. " +
      "Use to self-invoke /answer after asking questions, run /reload after creating skills, or send follow-up prompts.",

    parameters: Type.Object({
      command: Type.String({ 
        description: "The command or message to execute (e.g., '/answer', '/reload', or any text)" 
      }),
      reason: Type.Optional(
        Type.String({ 
          description: "Optional explanation for why you're executing this command (shown to user)" 
        })
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { command, reason } = params;

      pendingCommand = { command, reason, id: randomUUID(), scheduled: false };

      const explanation = reason 
        ? `Queued for execution: ${command}\nReason: ${reason}`
        : `Queued for execution: ${command}`;

      return {
        content: [{ type: "text", text: explanation }],
        details: { 
          command,
          reason,
          queued: true,
        },
      };
    },
  });

  pi.on("agent_settled", () => {
    if (!pendingCommand || pendingCommand.scheduled) return;
    pendingCommand.scheduled = true;
    // Pi defers prompts submitted during settlement until notification handlers finish.
    // The command then receives a fresh command context, outside lifecycle dispatch.
    pi.sendUserMessage(`/execute-command-dispatch ${pendingCommand.id}`, {
      expandPromptTemplates: true,
    });
  });
}
