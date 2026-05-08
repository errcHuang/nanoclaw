---
name: add-codex
description: Add Codex-oriented workflow support to NanoClaw. Documents Codex as an optional external coding workflow, updates prompt guidance, and keeps runtime boundaries explicit.
---

# Add Codex Support

This local skill adds Codex-specific workflow guidance to NanoClaw without changing
the default runtime. Use it when the user wants the repo to acknowledge Codex as
an optional external coding agent for local development work.

## Goal

Extend the current NanoClaw install so the assistant can:
- understand local Codex usage conventions
- help with Codex-oriented coding workflows
- document when Codex should be used versus the default NanoClaw runtime
- preserve clear boundaries between planning, execution, and user-visible actions
- avoid implying that Codex is wired into NanoClaw agent containers unless that
  integration is added separately

## Phase 1: Pre-flight

1. Check whether the repo already mentions Codex.
2. Check whether there is real Codex runtime integration or only a desired workflow.
3. Default to documentation and prompt-guidance updates unless actual executable
   integration exists in the codebase.

## Phase 2: Design

Before changing code, decide:
- whether Codex support is advisory or executable from the agent environment
- which files should be updated:
  - `groups/main/CLAUDE.md`
  - `CLAUDE.md`
  - `README.md`
  - local skill docs

For this fork, Codex support should be treated as advisory documentation only
until a concrete runtime bridge is added.

## Phase 3: Implement

When implementing for real:
1. Update prompt guidance so the assistant distinguishes:
   - NanoClaw's default Claude runtime
   - optional repo-local Codex usage by a developer
2. Update docs so contributors know Codex is a workflow aid, not a built-in
   NanoClaw runtime.
3. Only add install/setup steps if the repo actually ships Codex tooling.
4. Verify that Codex guidance does not suggest unsupported execution paths.

## Verify

At minimum, confirm the assistant can:
- explain the Codex workflow available in this repo
- distinguish Codex-specific actions from standard NanoClaw behavior
- avoid claiming Codex execution support unless it is actually wired in

## Notes

- This skill is intentionally local to this fork.
- It is a local operational skill, not a marketplace feature branch.
- Keep the final implementation explicit about what is and is not executable from NanoClaw.
