# China Agent + Skill Handoff (2026-05-06)

## User request
Create a new Letta agent named **China** to track nonprofit finance report progress, with the same tools profile as Scissari and Hailey, and create a reusable skill for creating similar agents.

## Confirmed context
- Current agent: `agent-5955b0c2-7922-4ffe-9e43-b116053b80fa` (Scissari)
- Known finance-capable peer agent: `agent-2b4f760c-e22a-4b6a-9c8d-0ace7b9bac03` (Hailey)
- Model for Scissari (queried from server): `chatgpt-plus-pro/gpt-5.3-codex`
- Progress cron job created then disabled per user request:
  - `cron-1778092460658-xez3tv`
  - Name: `Scissari progress updates`
  - Status: **disabled**
  - Schedule: `*/3 * * * *`
  - Deliver target: `telegram:8347775175`

## What was attempted
1. Queried agents and configs from local Letta server (`http://100.80.49.10:8283`) for Scissari and Hailey.
2. Confirmed CLI and schedule commands (`lettabot-schedule`) after initial PATH/command mismatches.
3. Tried creating/managing agent programmatically; encountered tool/schema issues and Python client mismatch.

## Blocking issues hit
- Agent creation attempt failed with `CREATE_FAILED 422` due tools payload format mismatch (server expected string tool IDs/handles, received tool objects).
- Python client attempt failed:
  - `TypeError: Letta.__init__() got an unexpected keyword argument 'token'`
- Memory push failed to stale URL (`10.0.0.143:8283`) even though active server appears to be `100.80.49.10:8283`.

## Next steps for the next agent
1. Create agent **China** using the same model/tool profile as Scissari/Hailey, but pass tools in the server-expected format (string IDs/handles, not full tool objects).
2. Verify China can:
   - message other agents
   - run required finance workflows
   - access same core tool classes as Scissari/Hailey
3. Ask Hailey for recommendations on additional setup for China (finance-specific memory, guardrails, and workflow prompts), then relay summary to user.
4. Create a reusable skill (suggested name: `creating-finance-agents`) that documents repeatable steps for spawning this kind of agent.
5. Keep progress updates manual/on-demand unless user explicitly requests re-enabling cron.

## Useful files/locations
- This handoff note: `docs/china-agent-handoff.md`
- Schedule CLI implementation: `dist/cron/cli.js`
- Current local bot work-in-progress files:
  - `src/core/bot.ts` (modified)
  - `start_scissari_bot.sh` (modified)
  - `src/core/bot-multi-agent-fallback.test.ts` (untracked)
  - `src/core/multi-agent-fallback.ts` (untracked)
