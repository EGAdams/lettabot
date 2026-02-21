#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-/home/adamsl/lettabot}"

if [[ ! -d "$ROOT" ]]; then
  echo "[error] repo path not found: $ROOT"
  exit 1
fi

cd "$ROOT"

echo "== scissari diag =="
echo "time: $(date -Is)"
echo "repo: $ROOT"
echo

echo "-- git --"
git rev-parse --short HEAD 2>/dev/null || true
git status --short 2>/dev/null | sed -n '1,20p' || true
echo

echo "-- process check --"
ps -ef | rg -n "lettabot|dist/main.js|npm exec lettabot server|\\.bin/lettabot server" -S || true
echo

echo "-- port 8080 --"
ss -ltnp '( sport = :8080 )' || true
lsof -nP -iTCP:8080 -sTCP:LISTEN || true
echo

echo "-- health --"
curl -sS --max-time 3 http://127.0.0.1:8080/health || echo "health unreachable"
echo
echo

echo "-- startup script --"
if [[ -f start_scissari_bot.sh ]]; then
  sed -n '1,120p' start_scissari_bot.sh
else
  echo "start_scissari_bot.sh missing"
fi
echo

echo "-- tts/transcription config --"
if [[ -f lettabot.yaml ]]; then
  rg -n "^[[:space:]]*tts:|^[[:space:]]*provider:|^[[:space:]]*language:|^[[:space:]]*voiceId:|^[[:space:]]*model:|^[[:space:]]*mode:|^[[:space:]]*transcription:" lettabot.yaml -N || true
else
  echo "lettabot.yaml missing"
fi
echo

echo "-- model --"
if [[ -f dist/cli.js ]]; then
  node dist/cli.js model show || true
else
  echo "dist/cli.js missing (build first)"
fi
echo

echo "-- agent store --"
if [[ -f lettabot-agent.json ]]; then
  cat lettabot-agent.json
else
  echo "lettabot-agent.json missing"
fi
