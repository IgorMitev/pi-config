Excellent! Context gathering complete. Here's what I found:

## Summary

I've created a comprehensive context document at `/Users/haza/Projects/pi-config/context.md` that maps out everything needed to implement the watchdog extension.

### Key Findings

**Plan Structure** (from 2026-03-03-watchdog-extension.md):
- Single-file extension at `~/.pi/agent/extensions/watchdog.ts`
- Two-phase monitoring: quick heuristic check → Haiku judge when stuck
- Timer-based (default 5 min intervals)
- Activity tracking via events: `turn_end`, `tool_execution_end`, `tool_execution_update`, `message_end`, `agent_end`
- Intervention actions: "nudge", "abort", "continue"
- 3 consecutive interventions → disable watchdog

**Extension Directory**:
- `~/.pi/agent/extensions/` exists but is empty (ready for watchdog)
- Global location enables auto-discovery and `/reload` support

**Key API Patterns** (from extensions.md, session.md, and examples):

1. **Event Subscription** - `pi.on("event_name", async (event, ctx) => { ... })`
2. **Activity Tracking** - Multiple event handlers update timestamps
3. **Context Access** - `ctx.isIdle()`, `ctx.abort()`, `ctx.getContextUsage()`, `ctx.sessionManager.getBranch()`
4. **User Messaging** - `pi.sendUserMessage(text, { deliverAs: "steer" })` for interruptions
5. **UI Status** - `ctx.ui.setStatus("watchdog", "🐵 5m")`  for footer display
6. **Shell Execution** - `pi.exec("pi", [args])` to spawn Haiku judge with 30s timeout
7. **Commands** - `pi.registerCommand("watchdog", { ... })` for `/watchdog` control

**Session Structure**:
- Entries form a tree; use `ctx.sessionManager.getBranch()` to get recent messages
- Entry types: `message`, `compaction`, `custom`, `model_change`
- Message roles: `user`, `assistant`, `toolResult`, `bashExecution`, `custom`

**Judge Pattern**:
- Spawn via `pi.exec()` with `-p --no-session --no-tools --model anthropic/claude-haiku-3-5`
- Send context (last 20 entries + token usage) as part of prompt
- Expect JSON output: `{ action: "continue"|"nudge"|"abort", message: "...", compact: boolean }`

### Document Structure

The context file covers:
- Plan summary
- Event subscription patterns  
- Context helpers and API methods
- User messaging patterns
- UI status bar integration
- Session structure and entry types
- Timer & activity tracking patterns
- Haiku judge implementation pattern
- Intervention actions (nudge, abort, compact)
- State management approach
- Complete API signatures
- Implementation checklist
- Gotchas (judge timeout, false positives, context size, error handling, UI availability, etc.)
- Testing strategy

This provides workers with **exact API signatures, pattern templates, and a complete understanding of how to build the extension without guessing or needing to read through hundreds of lines of docs repeatedly**.