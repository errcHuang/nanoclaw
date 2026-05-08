# Cardmaxxing Issue→PR Loop

Automated daily workflow: NanoClaw wakes up, looks at open GitHub issues labeled `claw` in `Cardmaxxing/cardmaxxing`, and produces draft PRs using OpenAI Codex. All PRs go to human review — the bot never merges.

## What happens and when

**Daily at 9am** (local system time): The cardmaxxing group container starts, syncs the bot clone to `origin/main`, fetches open `claw`-labeled issues, and processes up to 3 per run. Each successful issue gets a draft PR opened on a `claw/issue-<N>` branch.

**Monday at 8am**: A separate compaction task re-reads the bot's memory files and rewrites them to remove stale entries.

**Label gate**: Only issues with the `claw` label are picked up. Remove the label to stop the bot from touching an issue. Add it when you want the bot to attempt it.

## The two-PAT split (why the bot can't push to main)

The bot uses two separate GitHub Personal Access Tokens:

| Token | Env var | Scopes | Where it lives |
|-------|---------|--------|----------------|
| Read-only PAT | `GITHUB_TOKEN_RO` | `contents:read`, `issues:write`, `pull-requests:write` | Passed into container |
| Push PAT | `GITHUB_TOKEN_PUSH` | `contents:write`, `pull-requests:write` | Host only, never enters container |

The container's `GH_TOKEN` is set to the read-only PAT. Without `contents:write`, any attempt to `git push` from inside the container fails at the GitHub API layer — not just at the application level. This is Layer A, the genuine lock.

## The request_pr IPC handshake (Layer B)

Since the container can't push directly, it asks the host to do it:

1. Container writes a JSON file to `/workspace/ipc/tasks/<timestamp>.json`:
   ```json
   {
     "type": "request_pr",
     "requestId": "pr-1234567890",
     "branch": "claw/issue-42",
     "title": "fix: add /healthz route (#42)",
     "body": "Resolves #42\n\n...",
     "issueNumber": 42
   }
   ```

2. The NanoClaw host IPC watcher picks it up and:
   - Rejects if `branch` doesn't match `^claw/issue-\d+$`
   - Rejects if changed files include `.github/workflows/` or `.env*`
   - Runs `git push` using the host's push PAT (never shared with the container)
   - Runs `gh pr create --draft`
   - Writes the reply to `/workspace/ipc/replies/<requestId>.json`

3. Container polls for the reply and reads the PR URL.

The host validates the branch name with a regex — even if the container is compromised, it can only ever push to branches matching `claw/issue-<number>`.

## The bot clone

The bot owns a separate git clone at `~/.cache/nanoclaw/repos/cardmaxxing`.

- This is **not** your personal working checkout (usually `~/cardmaxxing`). The two never interact.
- At the start of every run, the bot syncs to `origin/main` with `git reset --hard`. Any leftover state from a failed run is discarded.
- The bot's memory files (`.claw/`) live inside this clone but are excluded from git tracking via `.git/info/exclude`.

## Bot memory (`.claw/`)

Two files, both inside `~/.cache/nanoclaw/repos/cardmaxxing/.claw/`:

**MEMORY.md** (≤ 8 KB): Curated, durable pattern-level facts that survive code moves — build system quirks, conventions not in lint, hard limits learned from incidents. Updated at the end of each run when something new is learned.

**JOURNAL.md** (last 50 entries): Append-only run log. Each entry records what was attempted, what failed, and what worked. Auto-trimmed to 50 entries.

### Inspecting memory

```bash
cat ~/.cache/nanoclaw/repos/cardmaxxing/.claw/MEMORY.md
tail -100 ~/.cache/nanoclaw/repos/cardmaxxing/.claw/JOURNAL.md
```

### Wiping memory (start fresh)

```bash
rm -rf ~/.cache/nanoclaw/repos/cardmaxxing/.claw
mkdir -p ~/.cache/nanoclaw/repos/cardmaxxing/.claw
touch ~/.cache/nanoclaw/repos/cardmaxxing/.claw/MEMORY.md
touch ~/.cache/nanoclaw/repos/cardmaxxing/.claw/JOURNAL.md
```

## How to disable temporarily

Pause the scheduled task in SQLite:

```bash
sqlite3 ~/nanoclaw/store/messages.db \
  "UPDATE scheduled_tasks SET status = 'paused' WHERE id = 'cardmaxxing-daily-loop';"
```

Resume with:
```bash
sqlite3 ~/nanoclaw/store/messages.db \
  "UPDATE scheduled_tasks SET status = 'active' WHERE id = 'cardmaxxing-daily-loop';"
```

## How to trigger manually

Force the task to run on the next scheduler poll (within 60 seconds):

```bash
sqlite3 ~/nanoclaw/store/messages.db \
  "UPDATE scheduled_tasks SET next_run = datetime('now', '-1 minute') WHERE id = 'cardmaxxing-daily-loop';"
```

## Setup

### 1. Create GitHub PATs

Go to GitHub → Settings → Developer settings → Fine-grained tokens.

**Read-only PAT** (`GITHUB_TOKEN_RO`): Repository access: Cardmaxxing/cardmaxxing only.
Permissions: Contents (read), Issues (read/write), Pull requests (read/write).

**Push PAT** (`GITHUB_TOKEN_PUSH`): Repository access: Cardmaxxing/cardmaxxing only.
Permissions: Contents (read/write), Pull requests (read/write).

### 2. Log in to Codex (OAuth — recommended)

If you have a ChatGPT Plus account, run on the host:

```bash
codex login
```

This caches OAuth credentials to `~/.codex/auth.json`. NanoClaw reads that file
and injects it into the container automatically — no API key needed.

**When the token expires:** Codex will start failing inside the container. Fix by running
`codex login` on the host again, then `systemctl --user restart nanoclaw` to pick up the
refreshed `~/.codex/auth.json`.

Alternatively, add `OPENAI_API_KEY=sk-...` to `.env` if you prefer an API key.

### 3. Add to `.env`

```
GITHUB_TOKEN_RO=github_pat_...
GITHUB_TOKEN_PUSH=github_pat_...
```

### 4. Run setup script

```bash
npx tsx scripts/setup-cardmaxxing.ts
```

This clones the repo, creates bot memory files, registers the group, and inserts the scheduled tasks.

### 5. Rebuild and restart

```bash
./container/build.sh
systemctl --user restart nanoclaw
```

### 6. Verify

```bash
# Container has gh and codex
docker run --rm --entrypoint sh nanoclaw-agent:latest \
  -c 'gh --version && codex --version'

# Git push is blocked in container
docker run --rm --entrypoint sh nanoclaw-agent:latest \
  -c 'git push origin foo:main 2>&1 | head -3'

# Bot clone exists and is on main
git -C ~/.cache/nanoclaw/repos/cardmaxxing log --oneline -3
```

## Extending to other repos

The architecture is general. To add another repo:

1. Create a new group folder (e.g., `groups/myrepo/CLAUDE.md`) with the workflow adapted for that repo.
2. Create a new bot clone at `~/.cache/nanoclaw/repos/myrepo`.
3. Add the clone path to `~/.config/nanoclaw/mount-allowlist.json`.
4. Register the group and task via a setup script similar to `scripts/setup-cardmaxxing.ts`.
5. Add separate PATs for the new repo.
