---
name: pi-update-audit
description: Audits Pi core and configured package updates before or after installation and evaluates whether the current Pi settings, extensions, agents, and skills need adaptation. Use when asked to "audit Pi updates", "check for Pi updates", "review extension updates", "check compatibility before updating", or "audit after updating Pi". Requires explicit user approval before applying any proposed configuration change.
disable-model-invocation: true
---

# Audit Pi Updates

Collect update evidence, trace compatibility impact into the active Pi configuration, and gate every proposed configuration change on explicit user approval.

## Step 1: Select the phase

Interpret an optional argument as `before`, `after`, or `auto`. Default to `auto`.

| Phase | Purpose |
|---|---|
| `before` | Fetch remote metadata, inspect prospective changes, and save the installed baseline. |
| `after` | Compare installed code with the saved baseline and audit the applied update. |
| `auto` | Use `after` when the saved pre-update baseline differs from the installation; otherwise use `before`. |

Never run `pi update`, install packages, checkout refs, reset repositories, or clean working trees. The user owns the update operation.

## Step 2: Collect structured evidence

Run from the Pi config repository root:

```bash
python3 ${CLAUDE_SKILL_ROOT}/scripts/collect_audit.py collect --phase auto
```

Replace `auto` with the explicitly requested phase. The script:

- Uses `pi list` as the configured package inventory.
- Checks Pi core through npm metadata.
- Fetches Git tags and remote refs without changing package checkouts.
- Records dirty package checkouts.
- Captures commits and changed files before an update.
- Compares installed revisions with the saved baseline after an update.
- Writes audit metadata only to `${XDG_STATE_HOME:-$HOME/.local/state}/pi-update-audit/state.json`.

The JSON result contains `phase`, `inventory`, `warnings`, and either a prospective `baseline` or an installed `comparison`. Treat collector warnings as unresolved evidence; do not silently infer success.

If the script fails, diagnose the exact command or malformed package. Do not substitute `pi update` as a discovery mechanism.

## Step 3: Establish the audit scope

Read:

- `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/settings.json`
- `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/AGENTS.md`
- Configured `agents/*.md`
- Loaded local extensions and skills that consume changed APIs or result formats
- Package manifests and filters reported by `pi list`

Ignore stale package clones that are absent from `pi list`. Preserve all dirty files and call them out before proposing changes.

When the collector reports changes, read `${CLAUDE_SKILL_ROOT}/references/compatibility-checklist.md` and inspect only the relevant upstream diffs, changelogs, release notes, and local consumers.

For a core version change, locate authoritative release notes and read the relevant installed Pi documentation completely before proposing an API change. For Git packages, inspect the exact collector range with `git log` and `git diff`; do not rely only on commit subjects.

If an `after` audit has no baseline, perform a current-state compatibility audit, clearly state that an exact before/after delta is unavailable, and establish the baseline only after the audit is resolved.

## Step 4: Validate impact claims

For each upstream change:

1. Identify the changed behavior and evidence.
2. Search the active config for direct consumers and runtime interactions.
3. Determine the concrete consequence.
4. Classify it as `Action required`, `Recommended`, `No impact`, or `Uncertain`.
5. Name a focused validation command for required or recommended adaptations.

Run non-mutating validation already provided by the config, including `npm run validate:agents` when available. Do not manufacture impact from matching terminology alone.

## Step 5: Report before changing anything

Present this structure:

```markdown
# Pi Update Audit — Before|After

## Summary
- Pi core: installed → target, or baseline → installed
- Configured packages checked: N
- Updates or applied changes: N
- Verdict: compatible | changes proposed | unresolved

## Action required
- Evidence, local touch point, consequence

## Recommended
- Evidence, local touch point, benefit

## No impact
- Verified changes and why they do not touch active config

## Uncertain
- Missing evidence and exact next check

## Dirty checkouts
- Package and files that an update may overwrite

## Proposed changes
1. `path`: exact adaptation, rationale, and validation
```

Omit empty sections except `No impact`. Distinguish prospective findings in a `before` audit from observed findings in an `after` audit.

## Step 6: Enforce the approval gate

If there are proposed changes:

1. Show the complete numbered proposal list before editing.
2. Ask the user to reply with `approve all`, specific proposal numbers, or `none`.
3. End the turn and wait.
4. Apply only the explicitly approved proposals.
5. Do not interpret general acknowledgment, silence, or approval to update packages as approval to edit configuration.

Approval covers only the displayed proposal version. If investigation changes a proposal's files, behavior, or scope, display the revised proposal and ask again.

Never modify code inside an installed package checkout as a configuration adaptation. Change the config repository, package pin/filter, or local integration instead.

## Step 7: Apply and verify approved proposals

Before editing, re-read every target file and verify it has not changed since the proposal. Apply only approved changes, then run the named focused validations and the config's agent validator.

Report declined proposals as accepted risk; do not apply or hide them.

## Step 8: Complete the audit state

For a `before` audit, keep the pending baseline so a later `after` audit can compare the installation. Do not accept the prospective target as installed.

For an `after` audit, accept the installed state only after every proposal is approved and verified or explicitly declined:

```bash
python3 ${CLAUDE_SKILL_ROOT}/scripts/collect_audit.py accept --no-fetch
```

If unresolved findings remain because evidence or validation failed, do not accept the baseline. Explain what blocks completion.

Finish with the verdict, verification evidence, accepted/declined proposals, and whether the audit baseline was saved or accepted.
