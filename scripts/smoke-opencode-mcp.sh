#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-connectivity}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo "Missing .env in $ROOT_DIR" >&2
  exit 1
fi

set -a
source .env
set +a

MODEL="${DEFAULT_MODEL:-openrouter/stepfun/step-3.5-flash:free}"
IMAGE="${NANOCLAW_AGENT_IMAGE:-nanoclaw-agent:latest}"
RUNNER_DIST="$ROOT_DIR/container/agent-runner/dist"
TMP_CONFIG="$(mktemp)"
TMP_OUTPUT="$(mktemp)"
cleanup() {
  rm -f "$TMP_CONFIG" "$TMP_OUTPUT"
}
trap cleanup EXIT

if [[ ! -d "$RUNNER_DIST" ]]; then
  echo "Missing $RUNNER_DIST. Build the container runner first." >&2
  exit 1
fi

need_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required env var: $name" >&2
    exit 1
  fi
}

need_env OPENROUTER_API_KEY

OPEN_BRAIN_ENABLED=false
GOOGLE_MAPS_ENABLED=false
SMOKE_CHAT_JID="${NANOCLAW_SMOKE_CHAT_JID:-}"
if [[ -n "${OPEN_BRAIN_KEY:-}" ]]; then
  OPEN_BRAIN_ENABLED=true
fi
if [[ -n "${GOOGLE_MAPS_API_KEY:-}" ]]; then
  GOOGLE_MAPS_ENABLED=true
fi
if [[ -z "$SMOKE_CHAT_JID" ]]; then
  SMOKE_CHAT_JID="${NANOCLAW_CHAT_JID:-}"
fi

need_env SMOKE_CHAT_JID

node - "$TMP_CONFIG" "$MODEL" "$OPEN_BRAIN_ENABLED" "$GOOGLE_MAPS_ENABLED" "$SMOKE_CHAT_JID" <<'EOF'
const fs = require('fs');

const [, , configPath, model, openBrainEnabled, googleMapsEnabled, smokeChatJid] = process.argv;

if (!model.startsWith('openrouter/')) {
  console.error(`This smoke test currently expects an openrouter/* model, got: ${model}`);
  process.exit(1);
}

const routerModelId = model.slice('openrouter/'.length);
const mcp = {
  nanoclaw: {
    type: 'local',
    enabled: true,
    command: ['node', '/app/dist/ipc-mcp-stdio.js'],
    environment: {
      NANOCLAW_CHAT_JID: smokeChatJid,
      NANOCLAW_GROUP_FOLDER: 'main',
      NANOCLAW_IS_MAIN: '1',
    },
  },
};

if (openBrainEnabled === 'true') {
  mcp['personal-mcp'] = {
    type: 'remote',
    enabled: true,
    url: 'https://mcp.ehuangapp.com/mcp',
    oauth: false,
    headers: {
      Authorization: 'Bearer {env:OPEN_BRAIN_KEY}',
    },
  };
}

if (googleMapsEnabled === 'true') {
  mcp['maps-grounding-lite-mcp'] = {
    type: 'remote',
    enabled: true,
    url: 'https://mapstools.googleapis.com/mcp',
    oauth: false,
    headers: {
      'X-Goog-Api-Key': '{env:GOOGLE_MAPS_API_KEY}',
    },
  };
}

const config = {
  $schema: 'https://opencode.ai/config.json',
  model: `orouter/${routerModelId}`,
  provider: {
    orouter: {
      npm: '@ai-sdk/openai-compatible',
      name: 'OpenRouter',
      options: {
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: '{env:OPENROUTER_API_KEY}',
      },
      models: {
        [routerModelId]: {
          name: routerModelId,
          limit: {
            context: 262144,
            output: 65536,
          },
        },
      },
    },
  },
  mcp,
  tools: {
    bash: false,
    write: false,
    edit: false,
    read: false,
  },
};

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
EOF

docker_run_args=(
  --rm
  -e OPENROUTER_API_KEY
  -e OPENCODE_CONFIG=/tmp/opencode-mcp-smoke.json
  -v "$TMP_CONFIG:/tmp/opencode-mcp-smoke.json:ro"
  -v "$RUNNER_DIST:/app/dist"
)

run_docker() {
  docker run "${docker_run_args[@]}" --entrypoint sh "$IMAGE" "$@"
}

case "$MODE" in
  connectivity)
    if [[ "$OPEN_BRAIN_ENABLED" == true ]]; then
      docker_run_args+=(-e OPEN_BRAIN_KEY)
    fi
    if [[ "$GOOGLE_MAPS_ENABLED" == true ]]; then
      docker_run_args+=(-e GOOGLE_MAPS_API_KEY)
    fi
    run_docker -lc 'opencode mcp list'
    ;;
  brain)
    need_env OPEN_BRAIN_KEY
    docker_run_args+=(-e OPEN_BRAIN_KEY)
    run_docker -lc 'timeout 30s opencode run --format json "Use the personal-mcp server to tell me my thought stats. You must use an MCP tool."' | tee "$TMP_OUTPUT"
    node - "$TMP_OUTPUT" <<'EOF'
const fs = require('fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean);
const toolCall = lines.find((line) => line.includes('"type":"tool_use"') && line.includes('"tool":"personal-mcp_thought_stats"') && line.includes('"status":"completed"'));
if (!toolCall) {
  console.error('Open Brain smoke test failed: no completed personal-mcp_thought_stats tool call found.');
  process.exit(1);
}
console.log('Open Brain smoke test passed.');
EOF
    ;;
  maps)
    need_env GOOGLE_MAPS_API_KEY
    docker_run_args+=(-e GOOGLE_MAPS_API_KEY)
    set +e
    run_docker -lc 'timeout 30s opencode run --format json "Use the maps-grounding-lite-mcp server to answer this question. You must use an MCP tool. What is the driving distance from San Francisco, CA to San Jose, CA?"' | tee "$TMP_OUTPUT"
    status=${PIPESTATUS[0]}
    set -e
    if [[ "$status" -ne 0 && "$status" -ne 124 ]]; then
      exit "$status"
    fi
    node - "$TMP_OUTPUT" <<'EOF'
const fs = require('fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean);
const attempted = lines.find((line) => line.includes('"type":"tool_use"') && line.includes('"tool":"maps-grounding-lite-mcp_compute_routes"'));
if (!attempted) {
  console.error('Maps smoke test failed: no maps-grounding-lite-mcp_compute_routes tool call found.');
  process.exit(1);
}
const completed = lines.find((line) => line.includes('"type":"tool_use"') && line.includes('"tool":"maps-grounding-lite-mcp_compute_routes"') && line.includes('"status":"completed"'));
if (!completed) {
  console.error('Maps smoke test failed: the model reached the Maps tool but did not complete successfully.');
  process.exit(1);
}
console.log('Maps smoke test passed.');
EOF
    ;;
  *)
    echo "Usage: $0 {connectivity|brain|maps}" >&2
    exit 1
    ;;
esac
