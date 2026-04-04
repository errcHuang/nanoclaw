# NanoClaw

Personal AI assistant harness. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp, stores state in SQLite, and routes work into Docker-isolated agent containers.

The host-side harness is provider-agnostic. The current runtime target is OpenCode via OpenRouter, with a temporary fallback path for the legacy Claude runtime during migration.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, runtime, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers and mounts runtime state |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/agent-runtime.ts` | Runtime-neutral host/container contract |
| `src/db.ts` | SQLite operations |
| `container/agent-runner/src/index.ts` | Container-side runtime adapter |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Local MCP bridge back to the host |
| `groups/{name}/CLAUDE.md` | Per-group memory and operating instructions |

## Runtime Notes

- Default runtime is OpenCode.
- Runtime selection is controlled by `AGENT_RUNTIME`.
- Default model selection is controlled by `DEFAULT_MODEL`.
- OpenRouter credentials are passed into the container runtime via stdin secrets, not mounted files.
- Per-group runtime state lives under `data/sessions/{group}/`.

## Development

Run commands directly rather than telling the user to run them.

```bash
npm run dev
npm run build
npm test
./container/build.sh
```

Container-side TypeScript build:

```bash
npm --prefix container/agent-runner run build
```

## Migration Guardrails

- Preserve feature parity before adding new behavior.
- Keep the host/runtime contract stable when changing the agent backend.
- Prefer deterministic behavior over clever routing or hidden heuristics.
- Add or update tests for scheduler behavior, session continuity, IPC/MCP access, and WhatsApp routing before flipping defaults.
