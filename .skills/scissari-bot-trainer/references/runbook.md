# Scissari LettaBot Runbook

## 1. Startup and Port Conflicts

Use this when startup fails with `EADDRINUSE` on `127.0.0.1:8080`.

```bash
cd /home/adamsl/lettabot
ss -ltnp '( sport = :8080 )'
ps -ef | rg -n "lettabot|dist/main.js|npm exec lettabot server" -S
```

If the listener is a stale Scissari process, stop it and restart with:

```bash
/home/adamsl/lettabot/start_scissari_bot.sh
```

The startup script already:
- loads `.env`,
- verifies `lettabot.yaml`,
- builds if needed,
- stops stale local `dist/main.js` listeners on 8080,
- starts `node dist/main.js`.

## 2. Unresponsive Bot

Collect quick diagnostics:

```bash
cd /home/adamsl/lettabot
.skills/scissari-bot-trainer/scripts/diag_scissari.sh
```

Then check:
- `/health` response (`ok` expected),
- Telegram startup logs in the running terminal,
- model/agent mapping in `lettabot-agent.json`.

## 2b. ADE Not Mirroring Bot Conversation

Symptom:
- Bot replies in Telegram, but ADE appears stale or shows a different thread.

Primary cause in this environment:
- split session state between:
  - `/tmp/lettabot/.letta/settings.local.json` (runtime working dir default)
  - `/home/adamsl/lettabot/.letta/settings.local.json` (repo local)

Checks:

```bash
cat /home/adamsl/lettabot/lettabot-agent.json
cat /tmp/lettabot/.letta/settings.local.json
cat /home/adamsl/lettabot/.letta/settings.local.json
ps -ef | rg -n "node dist/main.js|letta.js --output-format" -S
```

Expected:
- conversation IDs match across store/session files.

Fix:
- Pin `WORKING_DIR=/home/adamsl/lettabot` in startup flow (`start_scissari_bot.sh`).
- Restart bot from script so runtime and repo session state stay aligned.
- If needed, one-time sync from `/tmp/lettabot/.letta/settings.local.json` into repo `.letta/`.

## 3. Duplicate Replies or Repeated Voice Clips

Common causes:
- multiple running bot instances,
- interim stream flushes on non-editing channels,
- per-segment voice sends when Google TTS text is split.

Current expected implementation in this repo:
- TTS channels disable live editing (`src/channels/telegram.ts` `supportsEditing()`),
- core stream finalization avoids interim flushes when editing is disabled (`src/core/bot.ts`),
- Telegram TTS uses `sendVoice` for voice notes, not `sendAudio`,
- Google TTS segments are merged (`Buffer.concat`) and sent as one `sendVoice` message per reply.

If behavior regresses, verify those files first.

Quick checks:

```bash
cd /home/adamsl/lettabot
rg -n "sendVoice\\(|sendAudio\\(|Buffer\\.concat\\(segments\\)" src/channels/telegram.ts -S
rg -n "supportsEditing\\(|Finalize incremental chunks only on channels that support live edits" src/channels/telegram.ts src/core/bot.ts -S
```

## 4. Voice/TTS Changes

Current default (free) setup in `lettabot.yaml`:

```yaml
tts:
  provider: google
  language: en-US
  tld: com
  mode: text-and-voice
```

Notes:
- Google TTS is no-key and free.
- ElevenLabs can be used again by switching provider and providing key/quota.

## 5. Model Verification and Change

Do not trust the assistant's self-description of model identity.

Always verify via server:

```bash
cd /home/adamsl/lettabot
node dist/cli.js model show
```

Set model explicitly:

```bash
node dist/cli.js model set lc-openai/gpt-5-mini
```

## 6. Add Another Letta Bot

Use onboarding/config flow from repo root:

```bash
cd /home/adamsl/lettabot
node dist/cli.js onboard
```

Then confirm:
- new agent/channel entries in `lettabot.yaml`,
- agent ID and conversation mapping in `lettabot-agent.json`,
- single running process and healthy API.
