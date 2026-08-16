# Spec → Planner Workflow

Run an interactive specification session followed by an interactive planning session. This workflow produces a confirmed `spec.md`, a technical `plan.md`, and executable todos. It does not implement the todos.

**Announce at the start:** "I'll first open a spec session to clarify what to build. Once the spec is complete, I'll open a planner session to design how to build it."

## Interaction transport

Use direct-pane interaction by default. Use **parent-callback transport** only when the user explicitly asks the parent to minimize interaction or orchestrate gates and has supplied or authorized deterministic answers, defaults, or an acceptance-test response policy. Never infer substantive product or design choices merely to reduce interaction.

For parent-callback transport:

1. Add `Interaction transport: parent callbacks` to both subagent tasks, including the authorized response policy.
2. Spawn with `interactive: false` so callback and failure notifications wake the parent.
3. At every gate, the agent calls `caller_ping` and exits instead of waiting in its pane.
4. While more workflow gates remain, resume the same session with `subagent_resume({ sessionPath, message: response, autoExit: false })`.
5. When the authorized response ends the workflow, resume with `autoExit: true` and instruct the agent to summarize and call `subagent_done`. Automatic exit prevents a completed final response from leaving an idle pane if the agent omits the tool call.
6. Answer automatically only when the response follows directly from the authorized policy. Otherwise ask the user one consolidated question, then resume the agent with that answer.

Do not poll panes or session files to detect gates. If an agent reports that `caller_ping` is unavailable or waits in its pane despite callback mode, report the transport failure and stop the dry run rather than asking the user to repeatedly notify you.

## Artifact directory

Choose a short, filesystem-safe `<name>` from the request and use:

```text
.pi/plans/YYYY-MM-DD-<name>/
```

The artifacts are:

```text
.pi/plans/YYYY-MM-DD-<name>/spec.md
.pi/plans/YYYY-MM-DD-<name>/plan.md
```

Use the same directory and name throughout the workflow. Pass exact paths to both agents; do not ask them to choose paths.

## Phase 1: Specification

Spawn the global `spec` agent as an interactive subagent:

```typescript
subagent({
  name: "📝 Spec",
  agent: "spec",
  interactive: true,
  task: `Define the specification for: [the user's complete request]

Clarify WHAT to build: intent, behavior, scope, constraints, effort and quality level, and Ideal State Criteria. Do not design the technical implementation.

Write the completed specification to: .pi/plans/YYYY-MM-DD-<name>/spec.md`,
});
```

The user collaborates directly with the spec agent in its pane. Do not spawn the planner yet. Wait until the spec agent finishes and its result returns to this session.

Read `.pi/plans/YYYY-MM-DD-<name>/spec.md`. Confirm that the file exists and contains the agreed intent, scope, effort level, constraints, and ISC. If the spec agent reports a failure or does not produce the artifact, report that problem and stop. Do not invent or repair missing requirements in the parent session.

## Phase 2: Planning

After the specification is complete, spawn the global `planner` agent as an interactive subagent:

```typescript
subagent({
  name: "💬 Planner",
  agent: "planner",
  interactive: true,
  task: `Plan the implementation for the approved specification.

Read the specification at: .pi/plans/YYYY-MM-DD-<name>/spec.md
Write the technical plan to: .pi/plans/YYYY-MM-DD-<name>/plan.md
Create todos tagged with: <name>

Treat the specification as the authority for WHAT to build. Determine HOW to build it by investigating the codebase, exploring approaches, validating the design, and running a premortem. Do not implement the feature.`,
});
```

The user collaborates directly with the planner in its pane. Wait until the planner finishes and its result returns to this session.

Read the plan and list the todos. If the planner reports that the spec is incomplete, stop and explain the exact gap; do not silently resolve it or continue to implementation.

## Phase 3: Handoff

Summarize:

- Spec artifact path
- Plan artifact path
- Todo IDs and titles
- Chosen approach and key decisions
- Accepted or mitigated risks
- Any unresolved questions

Ask whether the user wants to execute the plan or adjust it. Do not spawn workers or a reviewer until the user explicitly requests execution.

## Completion checklist

Before reporting the workflow complete, verify:

1. The spec agent completed before the planner was spawned.
2. `spec.md` exists and was passed to the planner by exact path.
3. `plan.md` exists.
4. The planner created todos with the shared tag.
5. No implementation work was started.
