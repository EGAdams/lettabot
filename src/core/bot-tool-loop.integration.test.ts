import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@letta-ai/letta-code-sdk', () => ({
  createAgent: vi.fn(),
  createSession: vi.fn(),
  resumeSession: vi.fn(),
  imageFromFile: vi.fn(),
  imageFromURL: vi.fn(),
}));

import { createSession } from '@letta-ai/letta-code-sdk';
import { LettaBot } from './bot.js';
import type { ChannelAdapter } from '../channels/types.js';
import type { InboundMessage } from './types.js';

const LOOP_RESET_MSG =
  "(I got stuck in a tool loop and stopped. I've reset our conversation — please send your message again and I'll try a different approach.)";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAdapter(sent: string[]): ChannelAdapter {
  return {
    id: 'telegram',
    name: 'Telegram',
    async start() {},
    async stop() {},
    isRunning: () => true,
    async sendMessage(msg) {
      sent.push(msg.text);
      return { messageId: `m-${sent.length}` };
    },
    async editMessage(_chatId, _messageId, text) {
      sent.push(text);
    },
    async sendTypingIndicator() {},
    async stopTypingIndicator() {},
    supportsEditing: () => true,
  };
}

function makeInbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'telegram',
    chatId: 'chat-1',
    userId: 'user-1',
    userName: 'Tester',
    text: 'Hello',
    timestamp: new Date(),
    ...overrides,
  };
}

function makeMockSession(streamFactory: () => AsyncGenerator<unknown>) {
  return {
    initialize: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    stream: vi.fn().mockImplementation(streamFactory),
    close: vi.fn(() => undefined),
    abort: vi.fn(() => Promise.resolve()),
    agentId: 'agent-scissari',
    conversationId: 'conv-scissari',
  };
}

async function waitForMessages(sent: string[], count = 1, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (sent.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(sent.length).toBeGreaterThanOrEqual(count);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LettaBot tool loop detection', () => {
  let dataDir: string;
  let envBackup: Record<string, string | undefined>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lettabot-loop-'));
    envBackup = {
      DATA_DIR: process.env.DATA_DIR,
      LETTA_AGENT_ID: process.env.LETTA_AGENT_ID,
    };
    process.env.DATA_DIR = dataDir;
    process.env.LETTA_AGENT_ID = 'agent-scissari';
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(envBackup)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  // ── per-tool threshold for send_message_to_agent_and_wait_for_reply ─────────

  describe('send_message_to_agent_and_wait_for_reply loop threshold', () => {
    it('aborts at 3 distinct calls and delivers the reset message', async () => {
      const session = makeMockSession(async function* () {
        for (let i = 0; i < 3; i++) {
          yield {
            type: 'tool_call',
            toolCallId: `call-sma-${i}`,
            toolName: 'send_message_to_agent_and_wait_for_reply',
            toolInput: { agent_id: `agent-${i}`, message: 'hello' },
            uuid: `uuid-${i}`,
          };
        }
        // Bot breaks before this; yielding to let the generator terminate cleanly
        yield { type: 'result', success: true, result: '', conversationId: 'conv-scissari' };
      });

      vi.mocked(createSession).mockReturnValue(session as never);

      const bot = new LettaBot({ workingDir: join(dataDir, 'w'), allowedTools: [] });
      const sent: string[] = [];
      bot.registerChannel(makeAdapter(sent));

      await bot['channels'].get('telegram')!.onMessage!(makeInbound());
      await waitForMessages(sent, 1);

      expect(sent[0]).toBe(LOOP_RESET_MSG);
      expect(session.abort).toHaveBeenCalledTimes(1);
    });

    it('does NOT abort when only 2 calls are made (threshold is 3, not 2)', async () => {
      const session = makeMockSession(async function* () {
        for (let i = 0; i < 2; i++) {
          yield {
            type: 'tool_call',
            toolCallId: `call-sma-${i}`,
            toolName: 'send_message_to_agent_and_wait_for_reply',
            toolInput: { agent_id: `agent-${i}`, message: 'hello' },
            uuid: `uuid-${i}`,
          };
          yield {
            type: 'tool_result',
            toolCallId: `call-sma-${i}`,
            content: 'Done.',
            isError: false,
          };
        }
        yield { type: 'assistant', content: 'Both agents replied fine.', uuid: 'uuid-asst' };
        yield {
          type: 'result',
          success: true,
          result: 'Both agents replied fine.',
          conversationId: 'conv-scissari',
        };
      });

      vi.mocked(createSession).mockReturnValue(session as never);

      const bot = new LettaBot({ workingDir: join(dataDir, 'w'), allowedTools: [] });
      const sent: string[] = [];
      bot.registerChannel(makeAdapter(sent));

      await bot['channels'].get('telegram')!.onMessage!(makeInbound());
      await waitForMessages(sent, 1);

      expect(session.abort).not.toHaveBeenCalled();
      expect(sent[0]).not.toContain('reset our conversation');
      expect(sent[0]).toContain('Both agents replied fine.');
    });

    it('stops streaming and calls abort() exactly once even when more events follow', async () => {
      const session = makeMockSession(async function* () {
        // Emit 5 calls; bot should stop at 3
        for (let i = 0; i < 5; i++) {
          yield {
            type: 'tool_call',
            toolCallId: `call-sma-${i}`,
            toolName: 'send_message_to_agent_and_wait_for_reply',
            toolInput: { agent_id: `agent-${i}` },
            uuid: `uuid-${i}`,
          };
        }
        yield { type: 'result', success: true, result: '', conversationId: 'conv-scissari' };
      });

      vi.mocked(createSession).mockReturnValue(session as never);

      const bot = new LettaBot({ workingDir: join(dataDir, 'w'), allowedTools: [] });
      const sent: string[] = [];
      bot.registerChannel(makeAdapter(sent));

      await bot['channels'].get('telegram')!.onMessage!(makeInbound());
      await waitForMessages(sent, 1);

      expect(session.abort).toHaveBeenCalledTimes(1);
      expect(sent).toHaveLength(1);
    });
  });

  // ── streaming fragment deduplication ─────────────────────────────────────────

  describe('streaming fragment deduplication', () => {
    it('counts many streaming fragments of one call as a single distinct call', async () => {
      // One toolCallId with 5 raw-input fragments. If each fragment incremented
      // the per-tool counter (instead of just the first), count would be 6 > threshold 3
      // and the bot would incorrectly abort. With correct dedup the count is 1.
      const session = makeMockSession(async function* () {
        yield {
          type: 'tool_call',
          toolCallId: 'call-sma-1',
          toolName: 'send_message_to_agent_and_wait_for_reply',
          toolInput: {},
          uuid: 'uuid-1',
        };
        // Five subsequent argument fragments — same toolCallId, different raw payloads
        for (const raw of ['{"agent_id": "', 'agent-hailey', '", "message":', ' "hello"', '}']) {
          yield { type: 'tool_call', toolCallId: 'call-sma-1', toolInput: { raw }, uuid: 'uuid-1' };
        }
        yield { type: 'tool_result', toolCallId: 'call-sma-1', content: 'Reply received.', isError: false };
        yield { type: 'assistant', content: 'Single call succeeded.', uuid: 'uuid-asst' };
        yield {
          type: 'result',
          success: true,
          result: 'Single call succeeded.',
          conversationId: 'conv-scissari',
        };
      });

      vi.mocked(createSession).mockReturnValue(session as never);

      const bot = new LettaBot({ workingDir: join(dataDir, 'w'), allowedTools: [] });
      const sent: string[] = [];
      bot.registerChannel(makeAdapter(sent));

      await bot['channels'].get('telegram')!.onMessage!(makeInbound());
      await waitForMessages(sent, 1);

      // Must NOT have aborted (true count = 1; fragmented count would be 6)
      expect(session.abort).not.toHaveBeenCalled();
      expect(sent[0]).not.toContain('reset our conversation');
      expect(sent[0]).toContain('Single call succeeded.');
    });

    it('correctly counts 2 tool calls that each have streaming fragments', async () => {
      // 2 distinct IDs × fragments each. True count = 2 (< threshold 3) → no abort.
      const session = makeMockSession(async function* () {
        for (let i = 0; i < 2; i++) {
          yield {
            type: 'tool_call',
            toolCallId: `call-sma-${i}`,
            toolName: 'send_message_to_agent_and_wait_for_reply',
            toolInput: {},
            uuid: `uuid-${i}`,
          };
          yield { type: 'tool_call', toolCallId: `call-sma-${i}`, toolInput: { raw: '{"agent_id":"x"}' }, uuid: `uuid-${i}` };
          yield { type: 'tool_result', toolCallId: `call-sma-${i}`, content: 'ok', isError: false };
        }
        yield { type: 'assistant', content: 'Two calls done.', uuid: 'uuid-asst' };
        yield { type: 'result', success: true, result: 'Two calls done.', conversationId: 'conv-scissari' };
      });

      vi.mocked(createSession).mockReturnValue(session as never);

      const bot = new LettaBot({ workingDir: join(dataDir, 'w'), allowedTools: [] });
      const sent: string[] = [];
      bot.registerChannel(makeAdapter(sent));

      await bot['channels'].get('telegram')!.onMessage!(makeInbound());
      await waitForMessages(sent, 1);

      expect(session.abort).not.toHaveBeenCalled();
      expect(sent[0]).toContain('Two calls done.');
    });
  });

  // ── conversation reset after loop ─────────────────────────────────────────

  describe('conversation reset after loop abort', () => {
    it('creates a fresh session for the next message after the loop fires', async () => {
      // First session: 3 multi-agent tool calls → loop fires → session invalidated
      const loopSession = makeMockSession(async function* () {
        for (let i = 0; i < 3; i++) {
          yield {
            type: 'tool_call',
            toolCallId: `call-sma-${i}`,
            toolName: 'send_message_to_agent_and_wait_for_reply',
            toolInput: { agent_id: `agent-${i}` },
            uuid: `uuid-${i}`,
          };
        }
        yield { type: 'result', success: true, result: '', conversationId: 'conv-scissari' };
      });

      // Second session: normal response after the reset
      const freshSession = makeMockSession(async function* () {
        yield { type: 'assistant', content: 'Fresh start after reset.', uuid: 'uuid-fresh' };
        yield { type: 'result', success: true, result: 'Fresh start after reset.', conversationId: 'conv-new' };
      });

      vi.mocked(createSession)
        .mockReturnValueOnce(loopSession as never)
        .mockReturnValueOnce(freshSession as never);

      const bot = new LettaBot({ workingDir: join(dataDir, 'w'), allowedTools: [] });
      const sent: string[] = [];
      const adapter = makeAdapter(sent);
      bot.registerChannel(adapter);

      // First message → loop fires
      await bot['channels'].get('telegram')!.onMessage!(makeInbound({ text: 'Trigger loop' }));
      await waitForMessages(sent, 1);
      expect(sent[0]).toBe(LOOP_RESET_MSG);

      // Second message → must use a fresh session (not the invalidated loopSession)
      await bot['channels'].get('telegram')!.onMessage!(makeInbound({ text: 'Message after reset' }));
      await waitForMessages(sent, 2);

      // createSession called twice: once for the loop run, once after the auto-reset
      expect(createSession).toHaveBeenCalledTimes(2);
      expect(sent[1]).toBe('Fresh start after reset.');
    });

    it('delivers the reset message exactly once — no duplicate messages', async () => {
      const session = makeMockSession(async function* () {
        for (let i = 0; i < 3; i++) {
          yield {
            type: 'tool_call',
            toolCallId: `call-sma-${i}`,
            toolName: 'send_message_to_agent_and_wait_for_reply',
            toolInput: { agent_id: `agent-${i}` },
            uuid: `uuid-${i}`,
          };
        }
        yield { type: 'result', success: true, result: '', conversationId: 'conv-scissari' };
      });

      vi.mocked(createSession).mockReturnValue(session as never);

      const bot = new LettaBot({ workingDir: join(dataDir, 'w'), allowedTools: [] });
      const sent: string[] = [];
      bot.registerChannel(makeAdapter(sent));

      await bot['channels'].get('telegram')!.onMessage!(makeInbound());
      await waitForMessages(sent, 1);
      // Wait a bit to confirm nothing extra arrives
      await new Promise((r) => setTimeout(r, 100));

      expect(sent).toHaveLength(1);
      expect(sent[0]).toBe(LOOP_RESET_MSG);
    });
  });

  // ── global tool call cap ──────────────────────────────────────────────────

  describe('global tool call cap', () => {
    it('aborts and delivers reset message when the global cap is exceeded', async () => {
      // Use maxToolCalls: 5 to keep the test fast (avoids emitting 15+ events).
      // Use unique tool names so the per-tool threshold (8) is never hit —
      // only the global cap fires.
      const session = makeMockSession(async function* () {
        for (let i = 0; i < 10; i++) {
          yield {
            type: 'tool_call',
            toolCallId: `call-tool-${i}`,
            toolName: `tool_${i}`,  // all different → per-tool count stays at 1
            toolInput: { arg: i },
            uuid: `uuid-${i}`,
          };
          yield { type: 'tool_result', toolCallId: `call-tool-${i}`, content: 'ok', isError: false };
        }
        yield { type: 'result', success: true, result: '', conversationId: 'conv-scissari' };
      });

      vi.mocked(createSession).mockReturnValue(session as never);

      const bot = new LettaBot({
        workingDir: join(dataDir, 'w'),
        allowedTools: [],
        maxToolCalls: 5,  // low cap so the test only needs 6 distinct tool events
      });
      const sent: string[] = [];
      bot.registerChannel(makeAdapter(sent));

      await bot['channels'].get('telegram')!.onMessage!(makeInbound());
      await waitForMessages(sent, 1);

      expect(sent[0]).toBe(LOOP_RESET_MSG);
      expect(session.abort).toHaveBeenCalledTimes(1);
    });

    it('resets the conversation after the global cap fires', async () => {
      const loopSession = makeMockSession(async function* () {
        for (let i = 0; i < 10; i++) {
          yield {
            type: 'tool_call',
            toolCallId: `call-tool-${i}`,
            toolName: `tool_${i}`,
            toolInput: { arg: i },
            uuid: `uuid-${i}`,
          };
          yield { type: 'tool_result', toolCallId: `call-tool-${i}`, content: 'ok', isError: false };
        }
        yield { type: 'result', success: true, result: '', conversationId: 'conv-scissari' };
      });

      const freshSession = makeMockSession(async function* () {
        yield { type: 'assistant', content: 'Back to normal.', uuid: 'uuid-fresh' };
        yield { type: 'result', success: true, result: 'Back to normal.', conversationId: 'conv-new' };
      });

      vi.mocked(createSession)
        .mockReturnValueOnce(loopSession as never)
        .mockReturnValueOnce(freshSession as never);

      const bot = new LettaBot({
        workingDir: join(dataDir, 'w'),
        allowedTools: [],
        maxToolCalls: 5,
      });
      const sent: string[] = [];
      const adapter = makeAdapter(sent);
      bot.registerChannel(adapter);

      await bot['channels'].get('telegram')!.onMessage!(makeInbound({ text: 'First' }));
      await waitForMessages(sent, 1);
      expect(sent[0]).toBe(LOOP_RESET_MSG);

      await bot['channels'].get('telegram')!.onMessage!(makeInbound({ text: 'Second' }));
      await waitForMessages(sent, 2);

      expect(createSession).toHaveBeenCalledTimes(2);
      expect(sent[1]).toBe('Back to normal.');
    });
  });
});
