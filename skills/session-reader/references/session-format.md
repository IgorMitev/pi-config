# Pi Session JSONL Format

## Contents
- File location and naming
- Line types
- Message structure
- Content types
- Subagent sessions
- Common pitfalls

## File Location and Naming

Sessions are stored in `~/.pi/agent/sessions/` organized by project:

```
~/.pi/agent/sessions/
├── --Users-haza-Projects-sentry--/
│   ├── 2026-02-20T20-17-15-095Z_1a6f6bc4-....jsonl
│   ├── subagent-artifacts/
│   │   ├── 5f316403_worker_input.md
│   │   ├── 5f316403_worker_output.md
│   │   └── 5f316403_worker.jsonl
```

- Directory names encode the project path with `--` delimiters and `-` replacing `/`
- Filenames: `<ISO-timestamp>_<UUID>.jsonl`
- Each line is a standalone JSON object

## Line Types

Every line has a `type` field:

| Type | Purpose | Key Fields |
|------|---------|------------|
| `session` | First line, session metadata | `version`, `id`, `timestamp`, `cwd` |
| `model_change` | Model switch event | `provider`, `modelId` |
| `thinking_level_change` | Thinking mode change | `thinkingLevel` |
| `message` | Conversation content | `message: {role, content, ...}` |
| `custom_message` | Extension event, including async subagent completion | `customType`, `content`, `details` |

## Message Structure

**Critical:** The actual message is nested inside a `message` field:

```json
{
  "type": "message",
  "id": "abc123",
  "parentId": "def456",
  "timestamp": "2026-02-20T20:49:39.589Z",
  "message": {
    "role": "user",
    "content": [{"type": "text", "text": "Hello"}],
    "timestamp": 1771620579506
  }
}
```

### Message Roles

| Role | Description |
|------|-------------|
| `user` | User messages |
| `assistant` | Agent responses (text, tool calls, thinking) |
| `toolResult` | Tool execution results |

### Assistant Messages with Metadata

```json
{
  "role": "assistant",
  "content": [...],
  "api": "anthropic-messages",
  "provider": "anthropic",
  "model": "claude-opus-4-6",
  "usage": {
    "input": 3, "output": 209,
    "cacheRead": 0, "cacheWrite": 11576, "totalTokens": 11788,
    "cost": {"input": 0.000015, "output": 0.005225, "total": 0.077}
  },
  "stopReason": "toolUse"
}
```

### toolResult Messages

```json
{
  "role": "toolResult",
  "toolCallId": "toolu_abc123",
  "toolName": "bash",
  "content": [{"type": "text", "text": "output here"}],
  "isError": false,
  "timestamp": 1771620584031
}
```

## Content Types

The `content` field is an array of typed objects:

| Type | Found In | Fields |
|------|----------|--------|
| `text` | user, assistant, toolResult | `text` |
| `toolCall` | assistant | `id`, `name`, `arguments` |
| `thinking` | assistant | `thinking`, `thinkingSignature` |

## Subagent Sessions

Current async subagents produce two records: a launch acknowledgement and a later completion event. Older sessions may instead contain one aggregate tool result.

### Current launch acknowledgement

The launch is a normal nested `message` whose `details` directly describe one run:

```json
{
  "type": "message",
  "message": {
    "role": "toolResult",
    "toolName": "subagent",
    "details": {
      "id": "ff90278e",
      "name": "Agent config audit",
      "task": "Review the configured agents",
      "agent": "reviewer",
      "sessionFile": "~/.pi/agent/sessions/<project>/<child>.jsonl",
      "status": "started"
    }
  }
}
```

`subagent_resume` uses the same direct-details shape.

### Current completion event

Completion arrives as a top-level custom message, not a nested conversation message:

```json
{
  "type": "custom_message",
  "customType": "subagent_result",
  "content": "Sub-agent completed...",
  "details": {
    "name": "Agent config audit",
    "task": "Review the configured agents",
    "agent": "reviewer",
    "exitCode": 0,
    "elapsed": 253,
    "sessionFile": "~/.pi/agent/sessions/<project>/<child>.jsonl"
  }
}
```

Match launch and completion primarily by `sessionFile`. `elapsed` is in seconds. A `subagent_ping` is a terminal “needs help” state for the original launch; a later resume is a new invocation using the same session path. Ignore `subagent_status` when collecting runs.

### Legacy aggregate format

Older sessions store `details.mode` and `details.results[]` on the nested `subagent` tool result:

```json
{
  "role": "toolResult",
  "toolName": "subagent",
  "details": {
    "mode": "single",
    "results": [...],
    "artifacts": {...}
  }
}
```

Legacy modes are `single`, `parallel`, and `chain`. Result objects may contain `agent`, `task`, `exitCode`, `messages`, `model`, `usage`, `progressSummary`, `skills`, `sessionFile`, and `artifactPaths`.

### Subagent Session File Locations

Use the current or legacy result's `sessionFile` when it exists. Legacy runs may also provide `artifactPaths.jsonlPath` or persistent files under `details.artifacts.files[]`. Parse child JSONL files with the same `read_session.py` script.

## Common Pitfalls

1. **Nested message:** Content is at `line.message.content`, NOT `line.content`
2. **Content is an array:** Even single messages use `[{type: "text", text: "..."}]`
3. **Tool results are separate entries:** Not inside the assistant message
4. **Large sessions:** Tool results often contain huge outputs
5. **String content:** Some older content fields may be plain strings
6. **Subagent details:** Tool-result `details` is a sibling of `content` on the nested message object
7. **Async completion:** Current result and ping details live on top-level `custom_message` records, not under `line.message`
8. **Ping/resume lifecycle:** Mark the pinged launch complete before correlating a later resume on the same session path
9. **Session paths:** Current `sessionFile` paths are normally persistent project session files; older temp paths may be cleaned up
