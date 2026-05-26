import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  retrieveAgent,
  createConversation,
  createConversationMessage,
} = vi.hoisted(() => ({
  retrieveAgent: vi.fn(),
  createConversation: vi.fn(),
  createConversationMessage: vi.fn(),
}));

vi.mock('@letta-ai/letta-code-sdk', () => ({
  createAgent: vi.fn(),
  createSession: vi.fn(),
  resumeSession: vi.fn(),
  imageFromFile: vi.fn(),
  imageFromURL: vi.fn(),
}));

vi.mock('@letta-ai/letta-client', () => ({
  Letta: class MockLettaClient {
    agents = {
      retrieve: retrieveAgent,
    };

    conversations = {
      create: createConversation,
      messages: {
        create: createConversationMessage,
      },
    };
  },
}));

import { createSession, resumeSession } from '@letta-ai/letta-code-sdk';
import { LettaBot } from './bot.js';
import type { ChannelAdapter } from '../channels/types.js';
import type { InboundMessage } from './types.js';

describe('LettaBot multi-agent fallback', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;
  let originalAgentId: string | undefined;
  let originalBaseUrl: string | undefined;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lettabot-multi-agent-fallback-'));
    originalDataDir = process.env.DATA_DIR;
    originalAgentId = process.env.LETTA_AGENT_ID;
    originalBaseUrl = process.env.LETTA_BASE_URL;
    originalApiKey = process.env.LETTA_API_KEY;

    process.env.DATA_DIR = dataDir;
    process.env.LETTA_AGENT_ID = 'agent-scissari';
    process.env.LETTA_BASE_URL = 'http://127.0.0.1:8283';
    process.env.LETTA_API_KEY = 'test-key';

    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;

    if (originalAgentId === undefined) delete process.env.LETTA_AGENT_ID;
    else process.env.LETTA_AGENT_ID = originalAgentId;

    if (originalBaseUrl === undefined) delete process.env.LETTA_BASE_URL;
    else process.env.LETTA_BASE_URL = originalBaseUrl;

    if (originalApiKey === undefined) delete process.env.LETTA_API_KEY;
    else process.env.LETTA_API_KEY = originalApiKey;

    rmSync(dataDir, { recursive: true, force: true });
  });

  it('delivers a reply when the SDK ends with an empty result after tokenized multi-agent tool calls', async () => {
    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield {
            type: 'tool_call',
            toolCallId: 'call-1',
            toolName: 'send_message_to_agent_and_wait_for_reply',
            toolInput: {},
            uuid: 'uuid-tool-1',
          };
          yield { type: 'tool_call', toolCallId: 'call-1', toolInput: { raw: '{"' }, uuid: 'uuid-tool-1' };
          yield { type: 'tool_call', toolCallId: 'call-1', toolInput: { raw: 'message' }, uuid: 'uuid-tool-1' };
          yield { type: 'tool_call', toolCallId: 'call-1', toolInput: ':' , uuid: 'uuid-tool-1' };
          yield { type: 'tool_call', toolCallId: 'call-1', toolInput: { raw: 'Hello Hailey' }, uuid: 'uuid-tool-1' };
          yield { type: 'tool_call', toolCallId: 'call-1', toolInput: ',' , uuid: 'uuid-tool-1' };
          yield { type: 'tool_call', toolCallId: 'call-1', toolInput: { raw: 'other_agent_id' }, uuid: 'uuid-tool-1' };
          yield { type: 'tool_call', toolCallId: 'call-1', toolInput: ':' , uuid: 'uuid-tool-1' };
          yield { type: 'tool_call', toolCallId: 'call-1', toolInput: { raw: 'agent-hailey' }, uuid: 'uuid-tool-1' };
          yield { type: 'tool_call', toolCallId: 'call-1', toolInput: { raw: '"}' }, uuid: 'uuid-tool-1' };
          yield {
            type: 'result',
            success: true,
            result: '',
            conversationId: 'conv-scissari',
          };
        })()
      ),
      close: vi.fn(() => undefined),
      abort: vi.fn(() => Promise.resolve()),
      agentId: 'agent-scissari',
      conversationId: 'conv-scissari',
    };

    retrieveAgent
      .mockResolvedValueOnce({ name: 'Scissari' })
      .mockResolvedValueOnce({ name: 'Hailey' });
    createConversation.mockResolvedValue({ id: 'conv-hailey' });
    createConversationMessage.mockResolvedValue((async function* () {
      yield {
        message_type: 'assistant_message',
        content: 'I am working on the ledger cleanup run.',
      };
      yield {
        message_type: 'stop_reason',
        stop_reason: 'end_turn',
        run_id: 'run-hailey-1',
      };
    })());

    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    const sent: string[] = [];
    let resolveDelivered: (() => void) | null = null;
    const delivered = new Promise<void>((resolve) => {
      resolveDelivered = resolve;
    });
    const adapter: ChannelAdapter = {
      id: 'telegram',
      name: 'Telegram',
      async start() {},
      async stop() {},
      isRunning: () => true,
      async sendMessage(msg) {
        sent.push(msg.text);
        resolveDelivered?.();
        return { messageId: 'm-1' };
      },
      async editMessage(_chatId, _messageId, text) {
        sent.push(text);
        resolveDelivered?.();
      },
      async sendTypingIndicator() {},
    };

    bot.registerChannel(adapter);

    const inbound: InboundMessage = {
      channel: 'telegram',
      chatId: 'chat-1',
      userId: 'user-1',
      userName: 'Tester',
      text: 'please send a test message to Hailey to see what she is working on.',
      timestamp: new Date(),
    };

    await adapter.onMessage?.(inbound);
    await delivered;

    expect(sent).toEqual([
      'Hailey replied:\n\nI am working on the ledger cleanup run.',
    ]);
    expect(createConversation).toHaveBeenCalledWith({ agent_id: 'agent-hailey' });
    expect(createConversationMessage).toHaveBeenCalledTimes(1);
  });
});
