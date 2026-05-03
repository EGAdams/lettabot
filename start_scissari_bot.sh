#!/usr/bin/env bash
set -euo pipefail

# Always run from this repository, no matter where the script is launched.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Keep runtime working dir aligned with repo so ADE/session state is not split
# between /tmp/lettabot and this project.
export WORKING_DIR="${WORKING_DIR:-$SCRIPT_DIR}"

# Load optional local environment overrides.
if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

if [[ ! -f "lettabot.yaml" ]]; then
  echo "Error: lettabot.yaml not found in $SCRIPT_DIR"
  exit 1
fi

if grep -q "YOUR-TELEGRAM-BOT-TOKEN" "lettabot.yaml"; then
  echo "Error: Replace YOUR-TELEGRAM-BOT-TOKEN in lettabot.yaml before starting."
  exit 1
fi

if grep -q "provider: elevenlabs" "lettabot.yaml" && [[ -z "${ELEVENLABS_API_KEY:-}" ]]; then
  echo "Warning: ElevenLabs TTS is enabled but ELEVENLABS_API_KEY is not set."
  echo "         Bot will fall back to text replies until the key is available."
fi

if [[ ! -d "node_modules" ]]; then
  echo "Error: node_modules not found. Run: npm install"
  exit 1
fi

echo "Starting Scissari bot from $SCRIPT_DIR"

# Ensure built output exists (this script now runs local code directly).
if [[ ! -f "dist/main.js" ]]; then
  echo "dist/main.js not found. Building..."
  npm run build
fi

# Resolve API port (priority: env override, then lettabot.yaml, then default).
LETTABOT_API_PORT="${LETTABOT_API_PORT:-$(
  grep -E '^[[:space:]]*port:[[:space:]]*[0-9]+' "lettabot.yaml" \
    | head -n 1 \
    | sed -E 's/.*port:[[:space:]]*([0-9]+).*/\1/'
)}"
LETTABOT_API_PORT="${LETTABOT_API_PORT:-8080}"

# If the configured port is already used by this same bot, stop the stale instance first.
LISTEN_PID="$(lsof -tiTCP:${LETTABOT_API_PORT} -sTCP:LISTEN || true)"
if [[ -n "${LISTEN_PID}" ]]; then
  CMDLINE="$(tr '\0' ' ' <"/proc/${LISTEN_PID}/cmdline" 2>/dev/null || true)"
  if [[ "${CMDLINE}" == *"/home/adamsl/lettabot/dist/main.js"* ]]; then
    echo "Stopping stale Scissari instance on port ${LETTABOT_API_PORT} (PID ${LISTEN_PID})..."
    kill "${LISTEN_PID}" || true
    sleep 1
  else
    echo "Error: port ${LETTABOT_API_PORT} is in use by PID ${LISTEN_PID} (${CMDLINE})."
    echo "       Stop that process or change lettabot server.api.port."
    exit 1
  fi
fi

exec node dist/main.js
