---
name: agent-codex
description: Run OpenAI Codex CLI for non-interactive code generation tasks. Use codex exec with the workspace-write sandbox and ask-for-approval never for fully automated runs.
allowed-tools: Bash(codex:*)
---

# OpenAI Codex CLI — Agent Reference

## Standard invocation

Always run Codex in non-interactive exec mode with the workspace-write sandbox:

```bash
codex exec \
  --cd /workspace/extra/repo \
  --skip-git-repo-check \
  --sandbox workspace-write \
  --ask-for-approval never \
  -m gpt-5.4 \
  -c model_reasoning_effort='"medium"' \
  "<task prompt>"
```

**Required flags:**
- `--ask-for-approval never` — prevents interactive pauses
- `--sandbox workspace-write` — Codex can write files but not execute arbitrary commands
- `--skip-git-repo-check` — suppresses the interactive git-not-clean prompt
- `--cd <dir>` — working directory for file operations

## Retry pattern (on lint/typecheck failure)

```bash
ERROR_OUTPUT=$(npm run lint 2>&1 || true; npm run typecheck 2>&1 || true)
if [ -n "$ERROR_OUTPUT" ]; then
  codex exec \
    --cd /workspace/extra/repo \
    --skip-git-repo-check \
    --sandbox workspace-write \
    --ask-for-approval never \
    -m gpt-5.4 \
    -c model_reasoning_effort='"medium"' \
    "Fix these errors in the code you just wrote:\n\n$ERROR_OUTPUT"
fi
```

Only retry once. If the second attempt still fails, comment on the issue and abandon.

## Safety preamble

Prepend this to every Codex task prompt:

```
You are making targeted changes to fix the following GitHub issue.
Rules:
- Only modify files required by the issue. Do not refactor unrelated code.
- Do not touch .github/workflows/, .env*, or package-lock.json.
- Do not add, remove, or update any npm/yarn dependencies.
- Do not modify any authentication or security-related files.
- Write clean, idiomatic code consistent with the existing codebase style.
- Make the smallest change that solves the issue correctly.

Issue:
```

## Authentication

Codex authenticates via OAuth (ChatGPT account). Before the first `codex exec` in a session:

```bash
if [ -n "$CODEX_AUTH_JSON" ]; then
  mkdir -p /home/node/.codex
  printf '%s' "$CODEX_AUTH_JSON" > /home/node/.codex/auth.json
fi
```

`CODEX_AUTH_JSON` is injected automatically from the host's `~/.codex/auth.json`.
If `OPENAI_API_KEY` is set instead, codex will use that as a fallback.

## Notes

- Codex runs git operations inside its sandbox. The git push wrapper in this
  container blocks any push Codex might attempt — that is intentional.
- After Codex finishes, inspect the diff with `git diff HEAD` before committing.
- Codex operates on `/workspace/extra/repo` which is the bot's isolated clone,
  not the user's working checkout.
