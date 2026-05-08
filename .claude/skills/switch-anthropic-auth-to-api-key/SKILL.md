---
name: switch-anthropic-auth-to-api-key
description: Cut over NanoClaw from working Anthropic OAuth auth to Anthropic API-key auth in the current OneCLI-backed setup. Use when the repo already runs through OneCLI and the goal is to disable OAuth, keep API-key auth, verify container execution, and preserve a rollback path.
---

# Switch Anthropic Auth To API Key

This local skill documents the safe cutover from Anthropic OAuth to Anthropic API-key auth for this NanoClaw fork.

Use it only when:
- OneCLI is already installed and running
- NanoClaw is already configured to run container agents through OneCLI
- an Anthropic API key is already present in OneCLI or is ready to be added
- the current system still works with OAuth and you want a controlled cutover

Current expected repo state:
- `.env` contains `ONECLI_URL=...`
- NanoClaw container agents start through `onecli run`
- the OneCLI vault may currently contain both:
  - an `Anthropic` OAuth-style secret
  - an `Anthropic API Key` secret for `api.anthropic.com`

## Goal

End state:
- NanoClaw authenticates to Anthropic through the API key only
- the OAuth secret is removed or disabled
- a live container smoke test succeeds after the cutover

## Phase 1: Pre-flight

Confirm OneCLI is healthy:

```bash
export PATH="$HOME/.local/bin:$PATH"
onecli version
onecli secrets list --fields id,name,type,hostPattern --max 20
systemctl --user status nanoclaw --no-pager | sed -n '1,80p'
```

Confirm the repo still uses OneCLI:

```bash
grep -n '^ONECLI_URL=' .env
rg -n "ONECLI_URL|onecli run" src/container-runner.ts container/Dockerfile
```

Run a baseline smoke test before changing auth:

```bash
echo '{"prompt":"Reply with exactly OK.","groupFolder":"test-group","chatJid":"test@g.us","isMain":false}' \
  | docker run --rm -i -e ONECLI_URL=http://172.17.0.1:10254 nanoclaw-agent:latest
```

Do not proceed unless that returns a successful Claude response.

## Phase 2: Ensure API-Key Secret Exists

List current secrets:

```bash
onecli secrets list --fields id,name,type,hostPattern --max 20
```

If an API-key-backed secret for `api.anthropic.com` does not exist yet, add it:

```bash
onecli secrets create \
  --name "Anthropic API Key" \
  --type generic \
  --value YOUR_API_KEY \
  --host-pattern api.anthropic.com \
  --header-name x-api-key
```

Keep the OAuth secret in place until the final cutover step.

## Phase 3: Remove OAuth Secret

List secrets again and identify the OAuth-style secret named `Anthropic`:

```bash
onecli secrets list --fields id,name,type,hostPattern --max 20
```

Delete only the OAuth secret after confirming the API-key secret exists:

```bash
onecli secrets delete --id OAUTH_SECRET_ID
```

Do not delete the API-key secret.

## Phase 4: Verify After Cutover

Re-run the live smoke test:

```bash
echo '{"prompt":"Reply with exactly OK.","groupFolder":"test-group","chatJid":"test@g.us","isMain":false}' \
  | docker run --rm -i -e ONECLI_URL=http://172.17.0.1:10254 nanoclaw-agent:latest
```

Then restart NanoClaw:

```bash
systemctl --user restart nanoclaw
systemctl --user status nanoclaw --no-pager | sed -n '1,80p'
```

If desired, check recent logs:

```bash
journalctl --user -u nanoclaw -n 50 --no-pager
```

Success criteria:
- the smoke test returns a successful Claude response
- `nanoclaw.service` is running after restart
- there are no auth-related container errors in recent logs

## Rollback

If the API-key cutover fails, recreate the OAuth secret immediately:

```bash
onecli secrets create \
  --name "Anthropic" \
  --type anthropic \
  --value YOUR_OAUTH_TOKEN \
  --host-pattern api.anthropic.com
```

Then rerun the smoke test and restart NanoClaw again.

## Notes

- This repo does not need further code changes for the auth-method swap. The cutover is in OneCLI secret state, not in NanoClaw source.
- Keep only one intended Anthropic auth method active long term to avoid ambiguous behavior.
- Do not store the raw OAuth token or raw API key back into `.env`.
