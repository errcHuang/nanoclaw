---
name: add-vercel
description: Add Vercel deployment and docs workflow support to NanoClaw. Intended for users who want the assistant to inspect Vercel projects, deployments, domains, and logs through Vercel tooling.
---

# Add Vercel Support

This local skill is a scaffold for adding Vercel-specific workflow support to NanoClaw.
Use it when the user wants NanoClaw to work with Vercel projects, deployments, logs,
or Vercel documentation.

## Goal

Extend the current NanoClaw install so the main agent can:
- inspect Vercel projects and deployments
- search Vercel documentation
- help with deployment debugging and release verification
- use Vercel-specific guidance in the main prompt when those tools are available

## Phase 1: Pre-flight

1. Check whether Vercel tooling is already present in the environment.
2. Check whether the main prompt or any local docs already mention Vercel.
3. Check whether the intended integration should be:
   - connector/app-only
   - CLI-only
   - both connector and CLI

## Phase 2: Design

Before changing code, decide:
- whether Vercel should be available only in the main group or in all groups
- whether access is read-only or includes deploy actions
- whether deployment actions require explicit confirmation every time
- which files should document the capability:
  - `groups/main/CLAUDE.md`
  - container skill docs
  - setup or maintenance docs if needed

## Phase 3: Implement

When implementing for real:
1. Add the required Vercel tooling or connector access.
2. Update the main-group guidance so the assistant knows when to use Vercel tools.
3. Add or update tests/docs for any runtime behavior that changes.
4. Verify the assistant can inspect a deployment without breaking existing NanoClaw flows.

## Verify

At minimum, confirm the assistant can:
- identify a Vercel project
- inspect recent deployments
- surface useful deployment diagnostics
- avoid taking deploy or domain-changing actions without confirmation

## Notes

- This skill is intentionally local to this fork.
- It is a placeholder scaffold, not an upstream branch-distributed skill.
- Do not claim Vercel actions are available unless the underlying tooling has actually been wired in.
