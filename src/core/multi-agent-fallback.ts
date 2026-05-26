import { Letta } from '@letta-ai/letta-client';

const MULTI_AGENT_TOOL_NAMES = new Set([
  'send_message_to_agent_async',
  'send_message_to_agent_and_wait_for_reply',
]);

export type PendingMultiAgentToolCall = {
  toolCallId: string;
  toolName: string;
  toolArgs: string;
};

function getClient(): Letta {
  const baseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';
  const apiKey = process.env.LETTA_API_KEY;
  return new Letta({
    apiKey: apiKey || '',
    baseURL: baseUrl,
    defaultHeaders: { 'X-Letta-Source': 'lettabot' },
  });
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const text = (part as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

function parseToolArgs(toolArgs: string): Record<string, unknown> | null {
  const source = (toolArgs || '').trim();
  if (!source) return null;

  const otherAgentIdMatch =
    source.match(/other_agent_id["']?\s*:\s*["']([^"']+)["']/i) ||
    source.match(/other_agent_id["']?\s*:\s*([a-z0-9-]+)/i);

  const messageBeforeAgentMatch = source.match(
    /message["']?\s*:\s*["']([\s\S]*?)["']\s*,\s*other_agent_id/i,
  );
  const messageAfterAgentMatch = source.match(
    /other_agent_id["']?\s*:\s*["'][^"']+["']\s*,\s*message["']?\s*:\s*["']([\s\S]*?)["']\s*[\}\]]?$/i,
  );

  const extractedOtherAgentId = otherAgentIdMatch?.[1]?.trim();
  const extractedMessage =
    messageBeforeAgentMatch?.[1]?.trim() ?? messageAfterAgentMatch?.[1]?.trim();

  if (extractedOtherAgentId && extractedMessage) {
    return {
      message: extractedMessage,
      other_agent_id: extractedOtherAgentId,
    };
  }

  try {
    const parsed = JSON.parse(source || '{}');
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    const malformedMessageFirst = source.match(
      /^\s*\{?"?message:(.*),other_agent_id:([a-zA-Z0-9-]+)"?\}?\s*$/s,
    );
    if (malformedMessageFirst) {
      return {
        message: malformedMessageFirst[1].trim(),
        other_agent_id: malformedMessageFirst[2].trim(),
      };
    }

    const malformedAgentFirst = source.match(
      /^\s*\{?"?other_agent_id:([a-zA-Z0-9-]+),message:(.*)"?\}?\s*$/s,
    );
    if (malformedAgentFirst) {
      return {
        other_agent_id: malformedAgentFirst[1].trim(),
        message: malformedAgentFirst[2].trim(),
      };
    }

    return null;
  }
}

async function collectAssistantReply(
  stream: AsyncIterable<Record<string, unknown>>,
): Promise<{
  reply: string;
  runId: string | null;
  stopReason: string | null;
  conversationId: string | null;
}> {
  let reply = '';
  let runId: string | null = null;
  let stopReason: string | null = null;
  let conversationId: string | null = null;

  for await (const chunk of stream) {
    if (typeof chunk.run_id === 'string') runId = chunk.run_id;
    if (typeof chunk.conversation_id === 'string') {
      conversationId = chunk.conversation_id;
    }
    if (chunk.message_type === 'assistant_message') {
      reply += extractText(chunk.content);
    } else if (chunk.message_type === 'stop_reason') {
      stopReason =
        typeof chunk.stop_reason === 'string' ? chunk.stop_reason : null;
    }
  }

  return { reply: reply.trim(), runId, stopReason, conversationId };
}

function normalizeForComparison(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isMetaOrEchoReply(reply: string, originalMessage: string): boolean {
  const normalizedReply = normalizeForComparison(reply);
  const normalizedOriginal = normalizeForComparison(originalMessage);

  if (!normalizedReply) return true;
  if (normalizedReply === normalizedOriginal) return true;
  const metaPrefixes = [
    '**processing user request**',
    'processing user request',
    '**considering ',
    'considering ',
    '**exploring ',
    'exploring ',
    '**planning ',
    'planning ',
    '**examining skill tool usage**',
    'examining skill tool usage',
    "i'm thinking about",
    'i’m thinking about',
    'i need to ',
    'i should ',
    'i see i need to check for any available skills',
  ];
  if (metaPrefixes.some((prefix) => normalizedReply.startsWith(prefix))) {
    return true;
  }
  return false;
}

function buildFallbackRetryMessage(message: string): string {
  return `<system-reminder>
Reply in plain text only.
Do not use any tools for this answer.
Do not delegate.
Provide the best direct answer you can from your current context.
</system-reminder>

${message}`;
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const typedPart = part as { text?: unknown };
      return typeof typedPart.text === 'string' ? typedPart.text : '';
    })
    .join('')
    .trim();
}

async function recoverAssistantReplyFromHistory(
  client: Letta,
  runId: string | null,
  conversationId: string | null,
): Promise<string> {
  if (runId) {
    try {
      const page = await client.runs.messages.list(runId, { limit: 100 });
      const messages = page.getPaginatedItems?.() ?? [];
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        if (msg?.message_type !== 'assistant_message') continue;
        const text = extractMessageText(msg.content);
        if (text) return text;
      }
    } catch {
      // Fall through to conversation history.
    }
  }

  if (conversationId) {
    try {
      const page = await client.conversations.messages.list(conversationId, {
        limit: 100,
      });
      const messages = page.getPaginatedItems?.() ?? [];
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        if (msg?.message_type !== 'assistant_message') continue;
        const text = extractMessageText(msg.content);
        if (text) return text;
      }
    } catch {
      // Nothing else to try.
    }
  }

  return '';
}

export async function executePendingMultiAgentToolCall(
  call: PendingMultiAgentToolCall,
  senderAgentId: string,
): Promise<string | null> {
  if (!MULTI_AGENT_TOOL_NAMES.has(call.toolName)) return null;

  const args = parseToolArgs(call.toolArgs);
  const message = typeof args?.message === 'string' ? args.message : '';
  const otherAgentId =
    typeof args?.other_agent_id === 'string' ? args.other_agent_id : '';

  if (!message || !otherAgentId) return null;

  const client = getClient();
  const [senderAgent, targetAgent] = await Promise.all([
    client.agents.retrieve(senderAgentId),
    client.agents.retrieve(otherAgentId),
  ]);

  const reminder = `<system-reminder>
This message is from "${senderAgent.name}" (agent ID: ${senderAgentId}), an agent currently running inside the Letta Code CLI (docs.letta.com/letta-code).
The sender will only see the final message you generate (not tool calls or reasoning).
If you need to share detailed information, include it in your response text.
You are the target agent for this request. Answer the user-level request directly.
Do not delegate this request to another agent.
Do not call send_message_to_agent_async or send_message_to_agent_and_wait_for_reply for this request.
Do not ask the sender to provide another agent ID.
</system-reminder>

`;

  const sendAndCollect = async (payload: string) => {
    const conversation = await client.conversations.create({
      agent_id: otherAgentId,
    });
    const stream = await client.conversations.messages.create(conversation.id, {
      messages: [{ role: 'user', content: payload }],
      streaming: true,
      stream_tokens: true,
      include_pings: true,
      background: true,
      max_steps: 6,
      include_compaction_messages: true,
    });
    const result = await collectAssistantReply(
      stream as AsyncIterable<Record<string, unknown>>,
    );
    return {
      ...result,
      conversationId: result.conversationId ?? conversation.id,
    };
  };

  let { reply, runId, stopReason, conversationId } = await sendAndCollect(
    `${reminder}${message}`,
  );

  if (
    call.toolName === 'send_message_to_agent_and_wait_for_reply' &&
    (!reply || isMetaOrEchoReply(reply, message))
  ) {
    const retryResult = await sendAndCollect(
      buildFallbackRetryMessage(`${reminder}${message}`),
    );
    if (retryResult.reply) {
      reply = retryResult.reply;
      runId = retryResult.runId;
      stopReason = retryResult.stopReason;
      conversationId = retryResult.conversationId;
    }
  }

  if (
    call.toolName === 'send_message_to_agent_and_wait_for_reply' &&
    (!reply || isMetaOrEchoReply(reply, message))
  ) {
    reply = await recoverAssistantReplyFromHistory(client, runId, conversationId);
  }

  if (call.toolName === 'send_message_to_agent_async') {
    return `Message sent to ${targetAgent.name} (${otherAgentId}) in conversation ${conversationId ?? 'unknown'}.`;
  }

  if (!reply) {
    return `Message was sent to ${targetAgent.name} (${otherAgentId}), but no assistant reply was returned. Target run: ${runId ?? 'unknown'}, stop_reason: ${stopReason ?? 'unknown'}.`;
  }

  return `${targetAgent.name} replied:\n\n${reply}`;
}
