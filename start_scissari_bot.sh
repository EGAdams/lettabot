#!/usr/bin/env bash
set -euo pipefail

# Always run from this repository, no matter where the script is launched.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LOCAL_LETTA_CODE_DIR="${LOCAL_LETTA_CODE_DIR:-/home/adamsl/letta-code}"
LOCAL_LETTA_CLI_PATH="${LOCAL_LETTA_CLI_PATH:-$LOCAL_LETTA_CODE_DIR/letta.js}"

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

# The npm-published letta-code-sdk bundled here still resolves an older
# @letta-ai/letta-code CLI by default. Pin the SDK to the local checkout so
# Scissari gets the current multi-agent fallback and approval recovery logic.
if [[ -z "${LETTA_CLI_PATH:-}" && -f "$LOCAL_LETTA_CLI_PATH" ]]; then
  export LETTA_CLI_PATH="$LOCAL_LETTA_CLI_PATH"
  echo "Using local Letta CLI: $LETTA_CLI_PATH"
fi

# Ensure built output exists and is fresh enough. The bot runs dist/main.js, so
# a source-only crash fix is useless unless startup rebuilds it.
if [[ ! -f "dist/main.js" ]] || find src -type f \( -name '*.ts' -o -name '*.tsx' \) -newer "dist/main.js" -print -quit | grep -q .; then
  echo "Building fresh dist output..."
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
# Note: cmdline may be relative ("node dist/main.js") or absolute, so match on dist/main.js only.
LISTEN_PID="$(lsof -tiTCP:${LETTABOT_API_PORT} -sTCP:LISTEN || true)"
if [[ -n "${LISTEN_PID}" ]]; then
  CMDLINE="$(tr '\0' ' ' <"/proc/${LISTEN_PID}/cmdline" 2>/dev/null || true)"
  if [[ "${CMDLINE}" == *"dist/main.js"* ]]; then
    echo "Stopping stale Scissari instance on port ${LETTABOT_API_PORT} (PID ${LISTEN_PID})..."
    kill "${LISTEN_PID}" || true
    sleep 1
  else
    echo "Error: port ${LETTABOT_API_PORT} is in use by PID ${LISTEN_PID} (${CMDLINE})."
    echo "       Stop that process or change lettabot server.api.port."
    exit 1
  fi
fi

SUPERVISOR_PIDFILE="${SCRIPT_DIR}/.supervisor.pid"

# Prevent multiple supervisor instances using a PID file.
if [[ -f "${SUPERVISOR_PIDFILE}" ]]; then
  EXISTING_PID="$(cat "${SUPERVISOR_PIDFILE}" 2>/dev/null || true)"
  if [[ -n "${EXISTING_PID}" ]] && kill -0 "${EXISTING_PID}" 2>/dev/null; then
    echo "Error: another Scissari supervisor is already running (PID ${EXISTING_PID})."
    echo "       Run 'kill ${EXISTING_PID}' to stop it, or delete ${SUPERVISOR_PIDFILE}."
    exit 1
  fi
fi
echo $$ > "${SUPERVISOR_PIDFILE}"

stop_requested=0
child_pid=""

terminate_child() {
  stop_requested=1
  if [[ -n "${child_pid}" ]] && kill -0 "${child_pid}" 2>/dev/null; then
    echo "Stopping Scissari bot child PID ${child_pid}..."
    kill "${child_pid}" 2>/dev/null || true
    wait "${child_pid}" 2>/dev/null || true
  fi
  rm -f "${SUPERVISOR_PIDFILE}"
}

trap terminate_child INT TERM

if [[ "${LETTABOT_SUPERVISE:-1}" == "0" ]]; then
  exec node dist/main.js
fi

restart_count=0
while true; do
  # Before each restart, verify the port is free. If another process holds it,
  # abort so we don't spawn a child that immediately crashes with EADDRINUSE.
  LISTEN_PID="$(lsof -tiTCP:${LETTABOT_API_PORT} -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${LISTEN_PID}" ]] && [[ "${LISTEN_PID}" != "${child_pid}" ]]; then
    CMDLINE="$(tr '\0' ' ' <"/proc/${LISTEN_PID}/cmdline" 2>/dev/null || true)"
    echo "Error: port ${LETTABOT_API_PORT} is held by PID ${LISTEN_PID} (${CMDLINE:0:80}). Aborting restart."
    rm -f "${SUPERVISOR_PIDFILE}"
    exit 1
  fi

  echo "Launching Scissari bot child at $(date -Is)..."
  node dist/main.js &
  child_pid="$!"
  set +e
  wait "${child_pid}"
  exit_code="$?"
  set -e
  child_pid=""

  if [[ "${stop_requested}" == "1" ]]; then
    echo "Scissari bot supervisor stopped by signal."
    rm -f "${SUPERVISOR_PIDFILE}"
    exit 0
  fi

  restart_count=$((restart_count + 1))
  delay=$((restart_count < 6 ? restart_count * 5 : 30))
  echo "Scissari bot child exited with code ${exit_code}; restarting in ${delay}s (restart ${restart_count})."
  sleep "${delay}"
done
