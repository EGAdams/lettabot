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

import { createSession, resumeSession } from '@letta-ai/letta-code-sdk';
import { LettaBot } from './bot.js';

describe('SDK session contract', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;
  let originalAgentId: string | undefined;
  let originalRailwayMount: string | undefined;
  let originalSessionTimeout: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lettabot-sdk-contract-'));
    originalDataDir = process.env.DATA_DIR;
    originalAgentId = process.env.LETTA_AGENT_ID;
    originalRailwayMount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
    originalSessionTimeout = process.env.LETTA_SESSION_TIMEOUT_MS;

    process.env.DATA_DIR = dataDir;
    process.env.LETTA_AGENT_ID = 'agent-contract-test';
    delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
    delete process.env.LETTA_SESSION_TIMEOUT_MS;

    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;

    if (originalAgentId === undefined) delete process.env.LETTA_AGENT_ID;
    else process.env.LETTA_AGENT_ID = originalAgentId;

    if (originalRailwayMount === undefined) delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
    else process.env.RAILWAY_VOLUME_MOUNT_PATH = originalRailwayMount;

    if (originalSessionTimeout === undefined) delete process.env.LETTA_SESSION_TIMEOUT_MS;
    else process.env.LETTA_SESSION_TIMEOUT_MS = originalSessionTimeout;

    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reuses the same SDK session across follow-up sendToAgent calls', async () => {
    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'assistant', content: 'ack' };
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conversation-contract-test',
    };

    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    await bot.sendToAgent('first message');
    await bot.sendToAgent('second message');

    expect(vi.mocked(resumeSession)).not.toHaveBeenCalled();
    expect(vi.mocked(createSession)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createSession).mock.calls[0][1]).toMatchObject({
      permissionMode: 'default',
    });
    expect(mockSession.initialize).toHaveBeenCalledTimes(1);
    expect(mockSession.send).toHaveBeenCalledTimes(2);
    expect(mockSession.send).toHaveBeenNthCalledWith(1, 'first message');
    expect(mockSession.send).toHaveBeenNthCalledWith(2, 'second message');
    expect(mockSession.stream).toHaveBeenCalledTimes(2);
  });

  it('closes session if initialize times out before first send', async () => {
    process.env.LETTA_SESSION_TIMEOUT_MS = '5';

    const mockSession = {
      initialize: vi.fn(() => new Promise<never>(() => {})),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conversation-contract-test',
    };

    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    await expect(bot.sendToAgent('will timeout')).rejects.toThrow('Session initialize (key=shared) timed out after 5ms');
    expect(mockSession.close).toHaveBeenCalledTimes(1);
  });

  it('invalidates retry session when fallback send fails after conversation-missing error', async () => {
    const missingConversation = new Error('conversation not found');
    const retryFailure = new Error('network down');

    const firstSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async () => {
        throw missingConversation;
      }),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conversation-contract-test-1',
    };

    const secondSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async () => {
        throw retryFailure;
      }),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conversation-contract-test-2',
    };

    vi.mocked(createSession)
      .mockReturnValueOnce(firstSession as never)
      .mockReturnValueOnce(secondSession as never);
    vi.mocked(resumeSession).mockReturnValue(firstSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    await expect(bot.sendToAgent('trigger fallback')).rejects.toThrow('network down');
    expect(firstSession.close).toHaveBeenCalledTimes(1);
    expect(secondSession.close).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createSession)).toHaveBeenCalledTimes(2);
  });

  it('prefers terminal result text over pre-tool assistant scaffolding', async () => {
    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'assistant', content: 'I will call the tool now.' };
          yield { type: 'result', success: true, result: 'Final tool answer.' };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conversation-contract-test',
    };

    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    const response = await bot.sendToAgent('test');
    expect(response).toBe('Final tool answer.');
  });

  it('suppresses tool-planning assistant text when no terminal answer is provided', async () => {
    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'assistant', content: 'I will call the relay_message_to_chatgpt tool now.' };
          yield { type: 'result', success: true, result: '' };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conversation-contract-test',
    };

    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    const response = await bot.sendToAgent('test');
    expect(response).toBe('');
  });

  it('suppresses assistant text in "using the tool" meta format', async () => {
    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield {
            type: 'assistant',
            content:
              '**Using the tool for user request**\n\nI need to call relay_message_to_chatgpt before I can answer.',
          };
          yield { type: 'result', success: true, result: '' };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conversation-contract-test',
    };

    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    const response = await bot.sendToAgent('test');
    expect(response).toBe('');
  });

  it('suppresses assistant text that mentions internal relay tool execution', async () => {
    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield {
            type: 'assistant',
            content:
              '**Handling user requests**\n\nI should call relay_message_to_chatgpt now. Let’s proceed with the tool call!',
          };
          yield { type: 'result', success: true, result: '' };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conversation-contract-test',
    };

    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    const response = await bot.sendToAgent('test');
    expect(response).toBe('');
  });
});
