#!/usr/bin/env bash
set -euo pipefail

# Always run from this repository, no matter where the script is launched.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

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

if [[ ! -d "node_modules" ]]; then
  echo "Error: node_modules not found. Run: npm install"
  exit 1
fi

echo "Starting Scissari bot from $SCRIPT_DIR"
exec npx --no-install lettabot server
