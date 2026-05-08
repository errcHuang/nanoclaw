---
name: agent-github
description: GitHub operations via gh CLI — list issues, post comments, read PRs. Use for GitHub integration tasks. Does NOT support direct git push or gh pr create; use the request_pr IPC task for that.
allowed-tools: Bash(gh:*)
---

# GitHub CLI (gh) — Agent Reference

## Authentication

The container has a read-only GitHub PAT available as `GH_TOKEN`. This token has:
- `issues: write` — can list and comment on issues
- `pull-requests: write` — can read PRs (but NOT create them directly)
- `contents: read` — can read file content and refs
- **NO `contents: write`** — git push fails at the API layer regardless

`gh` picks up `GH_TOKEN` automatically. You do not need to run `gh auth login`.

Set the default repo once to avoid repeating `--repo` on every call:
```bash
export GH_REPO=Cardmaxxing/cardmaxxing
```

## Common operations

```bash
# List open issues with the claw label
gh issue list --label claw --state open --json number,title,body,url

# Read a single issue
gh issue view 42 --json number,title,body,url,labels

# Post a comment on an issue
gh issue comment 42 --body "message here"

# List open PRs for a branch
gh pr list --head claw/issue-42 --json number,url,state

# Check if a branch exists on origin
git ls-remote --heads origin claw/issue-42
```

## Creating PRs — use IPC, not gh pr create

**Do NOT run `gh pr create` directly.** The container's token lacks `contents:write`
so the push step inside `gh pr create` would fail anyway. The supported path is:

1. Commit your changes locally on a `claw/issue-<N>` branch.
2. Write a `request_pr` IPC task (see CLAUDE.md for exact format).
3. The host validates the branch name, pushes it, and opens the draft PR.
4. Poll `/workspace/ipc/replies/<requestId>.json` for the PR URL.

## Rate limits

The token is fine-grained and repo-scoped. All API calls count against the
Cardmaxxing/cardmaxxing repo's rate limit. Stay within normal usage.
