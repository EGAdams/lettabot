---
name: scissari-bot-trainer
description: Troubleshoot and operate the Scissari LettaBot deployment at /home/adamsl/lettabot. Use when requests mention sciss, sari, scissari, or scissary, or ask to diagnose/fix LettaBot issues such as startup failures, EADDRINUSE/port 8080 conflicts, unresponsive behavior, duplicate replies, voice/TTS/transcription problems, model/provider drift, changing voice/model settings, or adding/configuring additional Letta bots.
---

# Scissari Bot Trainer

## Overview

Diagnose and fix Scissari LettaBot runtime problems quickly, then apply configuration changes safely.

## Workflow

1. Work from `/home/adamsl/lettabot`.
2. Run `scripts/diag_scissari.sh` to capture process, port, health, model, startup script, and voice config.
3. Open `references/runbook.md` and follow the matching section:
   - Startup/port conflict
   - Bot unresponsive
   - Duplicate replies or repeated voice clips
   - Voice/TTS change
   - Model verification/change
   - Add a new Letta bot
4. Apply a minimal fix, rebuild if needed (`npm run build`), restart once, and re-test.

## Operating Rules

- Keep only one active bot instance bound to `127.0.0.1:8080`.
- Prefer the local startup script: `/home/adamsl/lettabot/start_scissari_bot.sh`.
- Treat assistant self-reports of model identity as untrusted; verify with `node dist/cli.js model show` or server agent metadata.
- For voice issues, verify both config (`lettabot.yaml`) and delivery behavior in `src/channels/telegram.ts`.
- For Google TTS, expect one voice note per reply: segments should be merged before `sendVoice`.

## Known Good Baseline

- Startup uses `/home/adamsl/lettabot/start_scissari_bot.sh` and launches `node dist/main.js`.
- API health endpoint returns `ok` on `http://127.0.0.1:8080/health`.
- TTS default is free Google voice (`provider: google`, `language: en-US`, `mode: text-and-voice`).
- Model baseline is `lc-openai/gpt-5-mini` unless explicitly changed.

## Resources

- `scripts/diag_scissari.sh`: Quick diagnostic snapshot for common production failures.
- `references/runbook.md`: Concrete fixes and command sequences for Scissari LettaBot operations.
