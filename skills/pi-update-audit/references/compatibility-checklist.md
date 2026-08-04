# Pi Update Compatibility Checklist

Use this checklist only after the collector reports core or package changes.

## Pi core

Check changed behavior against the installed documentation and the configuration:

- Settings keys, defaults, package filters, trust behavior, and package source semantics.
- Extension API imports, removed or renamed exports, factory lifecycle, event names, event payloads, and handler return values.
- Tool registration, argument schemas, result details, error signaling, active-tool filtering, and custom renderers.
- Session entry/message formats, `SessionManager`, compaction, session replacement, and custom message details.
- TUI components, themes, keybindings, UI lifecycle, and terminal-only guards.
- CLI flags, update behavior, environment variables, package installation paths, and resource discovery.
- Model/provider IDs, provider APIs, authentication, thinking levels, and model scoping.

Read the relevant current Pi documentation completely before proposing an API adaptation. Resolve documentation under the installed `@earendil-works/pi-coding-agent/docs` directory.

## Installed packages and local extensions

Check each changed package against every loaded consumer:

- Registered tool, command, shortcut, provider, message renderer, and event-bus names.
- Tool descriptions and prompt guidelines that alter agent behavior.
- Tool input and result-detail shapes parsed by skills, scripts, agents, or other extensions.
- Custom message types, session sidecars, temporary paths, and environment variables.
- Package manifest resource paths and filters in `settings.json`.
- Shared terminal multiplexer behavior, focus, panes, widgets, footer/status keys, and shutdown cleanup.
- Extension load order, duplicate registrations, and lifecycle-handler interactions.
- Direct imports or copied assumptions from another package.

Do not treat a changed file as an impact by itself. Trace an actual consumer or runtime interaction.

## Configured agents and skills

Check:

- Every `tools:` name resolves to an active built-in or loaded extension tool.
- Every `skill:` or `skills:` name resolves.
- Agent frontmatter remains supported by the subagent package.
- `auto-exit`, `interactive`, `session-mode`, `spawning`, restricted tools, and control tools still compose correctly.
- Agent instructions do not contradict changed tool descriptions or async delivery behavior.
- Skills that parse sessions or tool results tolerate added fields and detect removed or renamed fields.

Run the repository's agent validator when present.

## Severity

| Classification | Meaning |
|---|---|
| Action required | Current configuration will fail, lose behavior, or violate an explicit requirement. |
| Recommended | Configuration still works, but adapting removes a deprecation or material reliability risk. |
| No impact | The changed behavior has no loaded consumer or remains compatible. |
| Uncertain | Evidence is insufficient; name the exact smoke test or source needed. |

## Evidence standard

For every impact claim, cite:

1. The upstream commit, release note, or changed file.
2. The local consumer file and relevant symbol or declaration.
3. The concrete runtime consequence.

Do not propose speculative cleanup unrelated to the update.
