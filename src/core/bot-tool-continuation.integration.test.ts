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

const { executeChatGptRelayFallback } = vi.hoisted(() => ({
  executeChatGptRelayFallback: vi.fn(),
}));

vi.mock('./chatgpt-relay-fallback.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatgpt-relay-fallback.js')>();
  return {
    ...actual,
    executeChatGptRelayFallback,
  };
});

const { executePendingMultiAgentToolCall } = vi.hoisted(() => ({
  executePendingMultiAgentToolCall: vi.fn(),
}));

vi.mock('./multi-agent-fallback.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./multi-agent-fallback.js')>();
  return {
    ...actual,
    executePendingMultiAgentToolCall,
  };
});

import { createSession, resumeSession } from '@letta-ai/letta-code-sdk';
import { LettaBot } from './bot.js';
import type { ChannelAdapter } from '../channels/types.js';
import type { InboundMessage } from './types.js';
import { parseChatGptRelayArgs } from './chatgpt-relay-fallback.js';

// Prompt sent on every continuation turn (both paths).
const CONTINUATION_PROMPT =
  '<system-reminder>\n' +
  'Do not call any tools for this response.\n' +
  'Respond in plain text only.\n' +
  '</system-reminder>\n\n' +
  'Please provide the final user-visible answer to the previous message.';

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
    text: 'Ask ChatGPT with the relay tool, then tell me the final answer.',
    timestamp: new Date(),
    ...overrides,
  };
}

async function waitForSent(sent: string[], count = 1): Promise<void> {
  const deadline = Date.now() + 1000;
  while (sent.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(sent.length).toBeGreaterThanOrEqual(count);
}

describe('LettaBot tool continuation integration', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;
  let originalAgentId: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lettabot-tool-continuation-'));
    originalDataDir = process.env.DATA_DIR;
    originalAgentId = process.env.LETTA_AGENT_ID;

    process.env.DATA_DIR = dataDir;
    process.env.LETTA_AGENT_ID = 'agent-scissari';

    vi.clearAllMocks();
    executeChatGptRelayFallback.mockResolvedValue(null);
    executePendingMultiAgentToolCall.mockResolvedValue(null);
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;

    if (originalAgentId === undefined) delete process.env.LETTA_AGENT_ID;
    else process.env.LETTA_AGENT_ID = originalAgentId;

    rmSync(dataDir, { recursive: true, force: true });
  });

  it('continues a user-facing tool workflow when the first run has no final answer', async () => {
    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi
        .fn()
        .mockImplementationOnce(() =>
          (async function* () {
            yield {
              type: 'tool_call',
              toolCallId: 'call-chatgpt',
              toolName: 'relay_message_to_chatgpt',
              toolInput: { prompt: 'How is the Iran conflict going?' },
              uuid: 'tool-uuid',
            };
            yield {
              type: 'tool_result',
              toolCallId: 'call-chatgpt',
              content: 'ChatGPT returned data but no assistant message followed.',
              isError: false,
            };
            yield {
              type: 'result',
              success: true,
              result: '',
              conversationId: 'conv-scissari',
            };
          })(),
        )
        .mockImplementationOnce(() =>
          (async function* () {
            yield {
              type: 'assistant',
              content: 'ChatGPT says the situation remains volatile, with diplomatic talks still fragile.',
              uuid: 'assistant-uuid',
            };
            yield {
              type: 'result',
              success: true,
              result: 'ChatGPT says the situation remains volatile, with diplomatic talks still fragile.',
              conversationId: 'conv-scissari',
            };
          })(),
        ),
      close: vi.fn(() => undefined),
      abort: vi.fn(() => Promise.resolve()),
      agentId: 'agent-scissari',
      conversationId: 'conv-scissari',
    };

    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });
    const sent: string[] = [];
    const adapter = makeAdapter(sent);
    bot.registerChannel(adapter);

    await adapter.onMessage?.(makeInbound());
    await waitForSent(sent);

    expect(mockSession.send).toHaveBeenCalledTimes(2);
    expect(mockSession.send).toHaveBeenNthCalledWith(2, CONTINUATION_PROMPT);
    expect(sent).toEqual([
      'ChatGPT says the situation remains volatile, with diplomatic talks still fragile.',
    ]);
    expect(sent.join('\n')).not.toContain('The agent started a tool workflow');
  });

  it('emits the tool-workflow fallback only after the continuation also returns no answer', async () => {
    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi
        .fn()
        .mockImplementationOnce(() =>
          (async function* () {
            yield {
              type: 'tool_call',
              toolCallId: 'call-chatgpt',
              toolName: 'relay_message_to_chatgpt',
              toolInput: { prompt: 'How is the Iran conflict going?' },
              uuid: 'tool-uuid',
            };
            yield {
              type: 'result',
              success: true,
              result: '',
              conversationId: 'conv-scissari',
            };
          })(),
        )
        .mockImplementationOnce(() =>
          (async function* () {
            yield {
              type: 'result',
              success: true,
              result: '',
              conversationId: 'conv-scissari',
            };
          })(),
        ),
      close: vi.fn(() => undefined),
      abort: vi.fn(() => Promise.resolve()),
      agentId: 'agent-scissari',
      conversationId: 'conv-scissari',
    };

    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });
    const sent: string[] = [];
    const adapter = makeAdapter(sent);
    bot.registerChannel(adapter);

    await adapter.onMessage?.(makeInbound());
    await waitForSent(sent);

    expect(mockSession.send).toHaveBeenCalledTimes(2);
    expect(mockSession.send).toHaveBeenNthCalledWith(2, CONTINUATION_PROMPT);
    expect(sent).toEqual([
      '(I ran into an issue completing that request — the response was lost during a tool workflow. Please try again.)',
    ]);
  });

  it('executes the ChatGPT relay fallback for tokenized relay tool calls before continuing', async () => {
    executeChatGptRelayFallback.mockResolvedValue(
      'ChatGPT says the conflict update came back through the relay fallback.',
    );

    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield {
            type: 'tool_call',
            toolCallId: 'call-chatgpt',
            toolName: 'relay_message_to_chatgpt',
            toolInput: {},
            uuid: 'tool-uuid',
          };
          yield { type: 'tool_call', toolCallId: 'call-chatgpt', toolInput: { raw: '{"' }, uuid: 'tool-uuid' };
          yield { type: 'tool_call', toolCallId: 'call-chatgpt', toolInput: { raw: 'message' }, uuid: 'tool-uuid' };
          yield { type: 'tool_call', toolCallId: 'call-chatgpt', toolInput: ':', uuid: 'tool-uuid' };
          yield { type: 'tool_call', toolCallId: 'call-chatgpt', toolInput: { raw: 'How' }, uuid: 'tool-uuid' };
          yield { type: 'tool_call', toolCallId: 'call-chatgpt', toolInput: { raw: ' is' }, uuid: 'tool-uuid' };
          yield { type: 'tool_call', toolCallId: 'call-chatgpt', toolInput: { raw: ' the' }, uuid: 'tool-uuid' };
          yield { type: 'tool_call', toolCallId: 'call-chatgpt', toolInput: { raw: ' Iran' }, uuid: 'tool-uuid' };
          yield { type: 'tool_call', toolCallId: 'call-chatgpt', toolInput: { raw: ' conflict' }, uuid: 'tool-uuid' };
          yield { type: 'tool_call', toolCallId: 'call-chatgpt', toolInput: { raw: ' going' }, uuid: 'tool-uuid' };
          yield { type: 'tool_call', toolCallId: 'call-chatgpt', toolInput: { raw: ' right' }, uuid: 'tool-uuid' };
          yield { type: 'tool_call', toolCallId: 'call-chatgpt', toolInput: { raw: ' now?' }, uuid: 'tool-uuid' };
          yield { type: 'tool_call', toolCallId: 'call-chatgpt', toolInput: { raw: '","' }, uuid: 'tool-uuid' };
          yield { type: 'tool_call', toolCallId: 'call-chatgpt', toolInput: { raw: 'browser' }, uuid: 'tool-uuid' };
          yield { type: 'tool_call', toolCallId: 'call-chatgpt', toolInput: { raw: '_server' }, uuid: 'tool-uuid' };
          yield { type: 'tool_call', toolCallId: 'call-chatgpt', toolInput: { raw: '_url' }, uuid: 'tool-uuid' };
          yield { type: 'tool_call', toolCallId: 'call-chatgpt', toolInput: { raw: '":' }, uuid: 'tool-uuid' };
          yield { type: 'tool_call', toolCallId: 'call-chatgpt', toolInput: null, uuid: 'tool-uuid' };
          yield { type: 'tool_call', toolCallId: 'call-chatgpt', toolInput: { raw: '}' }, uuid: 'tool-uuid' };
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

    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });
    const sent: string[] = [];
    const adapter = makeAdapter(sent);
    bot.registerChannel(adapter);

    await adapter.onMessage?.(makeInbound());
    await waitForSent(sent);

    expect(executeChatGptRelayFallback).toHaveBeenCalledTimes(1);
    expect(String(executeChatGptRelayFallback.mock.calls[0][0])).toContain(
      'message:How is the Iran conflict going right now?',
    );
    expect(mockSession.send).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([
      'ChatGPT says the conflict update came back through the relay fallback.',
    ]);
  });

  it('repairs malformed streamed relay arguments', () => {
    const args = parseChatGptRelayArgs(
      '{"message:How is the Iran conflict going right now?","browser_server_url":,"executor_url":,"timeout_seconds":180}',
    );

    expect(args?.message).toBe('How is the Iran conflict going right now?');
    expect(args?.browser_server_url).toBe('');
    expect(args?.executor_url).toBe('');
    expect(args?.timeout_seconds).toBe(180);
  });

  // ─── Server-side MCP tool path (web_fetch_exa / web_search_exa) ─────────────
  //
  // Letta 0.16.7 does not stream tool_return_message for external MCP tools.
  // This means pendingServerToolCalls accumulates the call but never removes it.
  // The hadToolActivity continuation path must fire with the system-reminder so
  // the model responds in plain text rather than looping back to call the tool.

  it('sends continuation with system-reminder when server-side MCP tool has no tool_result', async () => {
    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi
        .fn()
        .mockImplementationOnce(() =>
          (async function* () {
            // web_fetch_exa executes server-side — Letta never streams a tool_result
            yield {
              type: 'tool_call',
              toolCallId: 'call-fetch',
              toolName: 'web_fetch_exa',
              toolInput: { urls: ['https://example.com'], maxCharacters: 12000 },
              uuid: 'uuid-fetch',
            };
            // No tool_result — result arrives empty (MCP executed server-side)
            yield {
              type: 'result',
              success: true,
              result: '',
              conversationId: 'conv-scissari',
            };
          })(),
        )
        .mockImplementationOnce(() =>
          (async function* () {
            yield {
              type: 'assistant',
              content: 'According to the page, the guide covers SCP and FTP upload workflows.',
              uuid: 'uuid-cont',
            };
            yield {
              type: 'result',
              success: true,
              result: 'According to the page, the guide covers SCP and FTP upload workflows.',
              conversationId: 'conv-scissari',
            };
          })(),
        ),
      close: vi.fn(() => undefined),
      abort: vi.fn(() => Promise.resolve()),
      agentId: 'agent-scissari',
      conversationId: 'conv-scissari',
    };

    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });
    const sent: string[] = [];
    const adapter = makeAdapter(sent);
    bot.registerChannel(adapter);

    await adapter.onMessage?.(makeInbound({ text: 'What does the upload guide say?' }));
    await waitForSent(sent);

    // Continuation must use the system-reminder so the model doesn't re-call web_fetch_exa
    expect(mockSession.send).toHaveBeenCalledTimes(2);
    expect(mockSession.send).toHaveBeenNthCalledWith(2, CONTINUATION_PROMPT);

    // The answer from the continuation reaches the user
    expect(sent).toEqual([
      'According to the page, the guide covers SCP and FTP upload workflows.',
    ]);
  });

  it('does not call multi-agent fallback for server-side MCP tools like web_fetch_exa', async () => {
    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi
        .fn()
        .mockImplementationOnce(() =>
          (async function* () {
            yield {
              type: 'tool_call',
              toolCallId: 'call-fetch',
              toolName: 'web_fetch_exa',
              toolInput: { urls: ['https://example.com'], maxCharacters: 12000 },
              uuid: 'uuid-fetch',
            };
            yield {
              type: 'result',
              success: true,
              result: '',
              conversationId: 'conv-scissari',
            };
          })(),
        )
        .mockImplementationOnce(() =>
          (async function* () {
            yield {
              type: 'result',
              success: true,
              result: 'Here is what I found on the page.',
              conversationId: 'conv-scissari',
            };
          })(),
        ),
      close: vi.fn(() => undefined),
      abort: vi.fn(() => Promise.resolve()),
      agentId: 'agent-scissari',
      conversationId: 'conv-scissari',
    };

    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });
    const sent: string[] = [];
    const adapter = makeAdapter(sent);
    bot.registerChannel(adapter);

    await adapter.onMessage?.(makeInbound({ text: 'Fetch this page for me.' }));
    await waitForSent(sent);

    // Must NOT attempt multi-agent fallback for a server-side MCP tool
    expect(executePendingMultiAgentToolCall).not.toHaveBeenCalled();

    // The continuation must be tried instead
    expect(mockSession.send).toHaveBeenCalledTimes(2);
    expect(mockSession.send).toHaveBeenNthCalledWith(2, CONTINUATION_PROMPT);
  });

  it('sends fallback message when continuation after server-side MCP tool also calls tools', async () => {
    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi
        .fn()
        // First stream: web_fetch_exa called, no tool_result, meta-only reasoning result
        .mockImplementationOnce(() =>
          (async function* () {
            yield {
              type: 'tool_call',
              toolCallId: 'call-fetch',
              toolName: 'web_fetch_exa',
              toolInput: { urls: ['https://example.com'], maxCharacters: 12000 },
              uuid: 'uuid-fetch',
            };
            yield {
              type: 'result',
              success: true,
              // Meta-only text: starts with "I will " → isMetaOnlyResponse returns true
              result: 'I will summarize the page content for you shortly.',
              conversationId: 'conv-scissari',
            };
          })(),
        )
        // Continuation stream: model ignores the system-reminder and calls web_fetch_exa again
        .mockImplementationOnce(() =>
          (async function* () {
            yield {
              type: 'tool_call',
              toolCallId: 'call-fetch-2',
              toolName: 'web_fetch_exa',
              toolInput: { urls: ['https://example.com'], maxCharacters: 12000 },
              uuid: 'uuid-fetch-2',
            };
            yield {
              type: 'result',
              success: true,
              result: '',
              conversationId: 'conv-scissari',
            };
          })(),
        ),
      close: vi.fn(() => undefined),
      abort: vi.fn(() => Promise.resolve()),
      agentId: 'agent-scissari',
      conversationId: 'conv-scissari',
    };

    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });
    const sent: string[] = [];
    const adapter = makeAdapter(sent);
    bot.registerChannel(adapter);

    await adapter.onMessage?.(makeInbound({ text: 'What does example.com say?' }));
    await waitForSent(sent);

    // Must send a fallback (not loop forever); must NOT be a raw tool-call leak
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain('web_fetch_exa');
    expect(sent[0]).not.toContain('tool_call');
    // The fallback message should not be an empty string
    expect(sent[0].trim()).not.toBe('');
  });
});
