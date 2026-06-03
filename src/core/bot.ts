/**
 * LettaBot Core - Handles agent communication
 * 
 * Single agent, single conversation - chat continues across all channels.
 */

import { createAgent, createSession, resumeSession, Session as LettaSession, imageFromFile, imageFromURL, type MessageContentItem, type SendMessage, type CanUseToolCallback } from '@letta-ai/letta-code-sdk';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChannelAdapter } from '../channels/types.js';
import type { BotConfig, InboundMessage, TriggerContext } from './types.js';
import type { AgentSession } from './interfaces.js';
import { Store } from './store.js';
import { updateAgentName, getPendingApprovals, rejectApproval, cancelRuns, recoverOrphanedConversationApproval, resetAgentMessages } from '../tools/letta-api.js';
import { installSkillsToAgent } from '../skills/loader.js';
import { formatMessageEnvelope, formatGroupBatchEnvelope, type SessionContextOptions } from './formatter.js';
import type { GroupBatcher } from './group-batcher.js';
import { loadMemoryBlocks } from './memory.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { parseDirectives, stripActionsBlock, type Directive } from './directives.js';
import { createManageTodoTool } from '../tools/todo.js';
import { syncTodosFromTool } from '../todo/store.js';
import { executePendingMultiAgentToolCall, type PendingMultiAgentToolCall } from './multi-agent-fallback.js';
import { executeChatGptRelayFallback } from './chatgpt-relay-fallback.js';
import { ThoughtBroadcaster } from './thought-broadcaster.js';


/**
 * Detect if a 409 error means the conversation is busy (another request in flight).
 * These should be retried with a delay, not treated as approval conflicts.
 */
function isConversationBusyError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('is currently being processed')) return true;
    if (msg.includes('conversation is busy')) return true;
  }
  // Also check nested SDK error body
  const apiErr = error as { status?: number; error?: { detail?: string; message?: string } };
  if (apiErr?.status === 409) {
    const detail = (apiErr.error?.detail ?? apiErr.error?.message ?? '').toLowerCase();
    if (detail.includes('is currently being processed')) return true;
  }
  return false;
}

/**
 * Detect if an error is a 409 CONFLICT from an orphaned approval.
 * Explicitly excludes "conversation busy" 409s — those need wait-and-retry, not recovery.
 */
function isApprovalConflictError(error: unknown): boolean {
  if (isConversationBusyError(error)) return false;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('waiting for approval')) return true;
    if (msg.includes('conflict') && msg.includes('approval')) return true;
  }
  const statusError = error as { status?: number };
  if (statusError?.status === 409) return true;
  return false;
}

/**
 * Detect if an error indicates a missing conversation or agent.
 * Only these errors should trigger the "create new conversation" fallback.
 * Auth, network, and protocol errors should NOT be retried.
 */
function isConversationMissingError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('not found')) return true;
    if (msg.includes('conversation') && (msg.includes('missing') || msg.includes('does not exist'))) return true;
    if (msg.includes('agent') && msg.includes('not found')) return true;
  }
  const statusError = error as { status?: number };
  if (statusError?.status === 404) return true;
  return false;
}

function normalizeResponseText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isMetaOnlyResponse(text: string): boolean {
  const normalized = normalizeResponseText(text);
  if (!normalized) return true;
  const metaPrefixes = [
    '**considering ',
    'considering ',
    '**exploring ',
    'exploring ',
    '**planning ',
    'planning ',
    '**processing user request**',
    'processing user request',
    '**using the tool for user request**',
    'using the tool for user request',
    '**using the tool',
    'using the tool',
    '**examining skill tool usage**',
    'examining skill tool usage',
    'i’m thinking about',
    "i'm thinking about",
    'i need to ',
    'i should ',
    'i will ',
    "i'll ",
    'let me ',
    'working on it',
    'i see i need to check for any available skills',
  ];
  if (
    metaPrefixes.some((prefix) => normalized.startsWith(prefix))
  ) {
    return true;
  }

  // For this bot role, any mention of internal relay-tool execution is
  // planning/meta text, not a user-facing answer.
  const internalToolMarkers = [
    'relay_message_to_chatgpt',
    'tool call',
    'call that tool',
    'call the tool',
    'use the tool',
  ];
  if (internalToolMarkers.some((marker) => normalized.includes(marker))) {
    return true;
  }

  const metaPatterns: RegExp[] = [
    /\b(i|we)\s+(will|would|can|should|need to|am going to|gonna)\s+(use|call|run|invoke|check|search|look up)\b/,
    /\b(let me|i'll)\s+(use|call|run|invoke|check|search|look up)\b/,
    /\b(call|use|run|invoke)\s+the\s+[\w-]+\s+tool\b/,
    /\busing\s+the\s+tool\b/,
    /\busing\s+the\s+[\w-]+\s+tool\b/,
  ];
  if (metaPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  return false;
}

const SUPPORTED_IMAGE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);

async function buildMultimodalMessage(
  formattedText: string,
  msg: InboundMessage,
): Promise<SendMessage> {
  if (process.env.INLINE_IMAGES === 'false') {
    return formattedText;
  }

  const imageAttachments = (msg.attachments ?? []).filter(
    (a) => a.kind === 'image'
      && (a.localPath || a.url)
      && (!a.mimeType || SUPPORTED_IMAGE_MIMES.has(a.mimeType))
  );

  if (imageAttachments.length === 0) {
    return formattedText;
  }

  const content: MessageContentItem[] = [
    { type: 'text', text: formattedText },
  ];

  for (const attachment of imageAttachments) {
    try {
      if (attachment.localPath) {
        content.push(imageFromFile(attachment.localPath));
      } else if (attachment.url) {
        content.push(await imageFromURL(attachment.url));
      }
    } catch (err) {
      console.warn(`[Bot] Failed to load image ${attachment.name || 'unknown'}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (content.length > 1) {
    console.log(`[Bot] Sending ${content.length - 1} inline image(s) to LLM`);
  }

  return content.length > 1 ? content : formattedText;
}

// ---------------------------------------------------------------------------
// Stream message type with toolCallId/uuid for dedup
// ---------------------------------------------------------------------------
export interface StreamMsg {
  type: string;
  content?: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
  uuid?: string;
  isError?: boolean;
  result?: string;
  success?: boolean;
  error?: string;
  [key: string]: unknown;
}

type PendingServerToolCall = {
  toolName: string;
  toolArgs: string;
  lastSignature?: string;
};

function appendToolArgFragment(
  pending: Map<string, PendingServerToolCall>,
  streamMsg: StreamMsg,
): void {
  if (streamMsg.type !== 'tool_call' || !streamMsg.toolCallId) return;

  const existing = pending.get(streamMsg.toolCallId) || {
    toolName: '',
    toolArgs: '',
  };

  if (typeof streamMsg.toolName === 'string' && streamMsg.toolName) {
    existing.toolName = streamMsg.toolName;
  }

  const input = streamMsg.toolInput;
  let fragment = '';
  if (
    input &&
    typeof input === 'object' &&
    'raw' in input &&
    typeof (input as { raw?: unknown }).raw === 'string'
  ) {
    fragment = (input as { raw: string }).raw;
  } else if (typeof input === 'string') {
    fragment = input;
  } else if (typeof input === 'number' || typeof input === 'boolean') {
    fragment = String(input);
  } else if (
    input &&
    typeof input === 'object' &&
    Object.keys(input as Record<string, unknown>).length > 0 &&
    !('raw' in (input as Record<string, unknown>))
  ) {
    fragment = JSON.stringify(input);
  }

  if (fragment) {
    const normalizedFragment = fragment.trim();
    if (
      existing.toolArgs &&
      normalizedFragment.length >= existing.toolArgs.length &&
      normalizedFragment.startsWith(existing.toolArgs)
    ) {
      // Newer CLI builds may stream cumulative JSON argument snapshots.
      existing.toolArgs = normalizedFragment;
    } else {
      existing.toolArgs += fragment;
    }
  }

  pending.set(streamMsg.toolCallId, existing);
}

export function isResponseDeliverySuppressed(msg: Pick<InboundMessage, 'isListeningMode'>): boolean {
  return msg.isListeningMode === true;
}

export class LettaBot implements AgentSession {
  private store: Store;
  private config: BotConfig;
  private channels: Map<string, ChannelAdapter> = new Map();
  private messageQueue: Array<{ msg: InboundMessage; adapter: ChannelAdapter }> = [];
  private lastUserMessageTime: Date | null = null;
  
  // Callback to trigger heartbeat (set by main.ts)
  public onTriggerHeartbeat?: () => Promise<void>;
  private groupBatcher?: GroupBatcher;
  private groupIntervals: Map<string, number> = new Map();
  private instantGroupIds: Set<string> = new Set();
  private listeningGroupIds: Set<string> = new Set();
  private processing = false; // Global lock for shared mode
  private processingKeys: Set<string> = new Set(); // Per-key locks for per-channel mode

  // AskUserQuestion support: resolves when the next user message arrives
  private pendingQuestionResolver: ((text: string) => void) | null = null;

  // Persistent sessions: reuse CLI subprocesses across messages.
  // In shared mode, only the "shared" key is used. In per-channel mode, each
  // channel (and optionally heartbeat) gets its own subprocess.
  private sessions: Map<string, LettaSession> = new Map();
  private currentCanUseTool: CanUseToolCallback | undefined;
  // Stable callback wrapper so the Session options never change, but we can
  // swap out the per-message handler before each send().
  private readonly sessionCanUseTool: CanUseToolCallback = async (toolName, toolInput) => {
    const command = getShellCommandFromToolInput(toolInput);
    if (isShellExecutionTool(toolName) && command && isDangerousShellCommandForHostedBot(command)) {
      console.warn(`[Bot] Denying dangerous shell command from ${toolName}: ${command.slice(0, 200)}`);
      return {
        behavior: 'deny' as const,
        message:
          'Denied: broad process-kill commands like pkill/killall can terminate the hosted lettabot process. ' +
          'Start background processes with a captured PID and stop only that PID instead.',
      };
    }
    if (this.currentCanUseTool) {
      return this.currentCanUseTool(toolName, toolInput);
    }
    return { behavior: 'allow' as const };
  };
  
  constructor(config: BotConfig) {
    this.config = config;
    mkdirSync(config.workingDir, { recursive: true });
    this.store = new Store('lettabot-agent.json', config.agentName);
    console.log(`LettaBot initialized. Agent ID: ${this.store.agentId || '(new)'}`);
  }

  // =========================================================================
  // Response prefix (for multi-agent group chat identification)
  // =========================================================================

  /**
   * Prepend configured displayName prefix to outbound agent responses.
   * Returns text unchanged if no prefix is configured.
   */
  private prefixResponse(text: string): string {
    if (!this.config.displayName) return text;
    return `${this.config.displayName}: ${text}`;
  }

  // =========================================================================
  // Session options (shared by processMessage and sendToAgent)
  // =========================================================================

  private getTodoAgentKey(): string {
    return this.store.agentId || this.config.agentName || 'LettaBot';
  }

  private syncTodoToolCall(streamMsg: StreamMsg): void {
    if (streamMsg.type !== 'tool_call') return;

    const normalizedToolName = (streamMsg.toolName || '').toLowerCase();
    const isBuiltInTodoTool = normalizedToolName === 'todowrite'
      || normalizedToolName === 'todo_write'
      || normalizedToolName === 'writetodos'
      || normalizedToolName === 'write_todos';
    if (!isBuiltInTodoTool) return;

    const input = (streamMsg.toolInput && typeof streamMsg.toolInput === 'object')
      ? streamMsg.toolInput as Record<string, unknown>
      : null;
    if (!input || !Array.isArray(input.todos)) return;

    const incoming: Array<{
      content?: string;
      description?: string;
      status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    }> = [];
    for (const item of input.todos) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const statusRaw = typeof obj.status === 'string' ? obj.status : '';
      if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(statusRaw)) continue;
      incoming.push({
        content: typeof obj.content === 'string' ? obj.content : undefined,
        description: typeof obj.description === 'string' ? obj.description : undefined,
        status: statusRaw as 'pending' | 'in_progress' | 'completed' | 'cancelled',
      });
    }
    if (incoming.length === 0) return;

    try {
      const summary = syncTodosFromTool(this.getTodoAgentKey(), incoming);
      if (summary.added > 0 || summary.updated > 0) {
        console.log(`[Bot] Synced ${summary.totalIncoming} todo(s) from ${streamMsg.toolName} into heartbeat store (added=${summary.added}, updated=${summary.updated})`);
      }
    } catch (err) {
      console.warn('[Bot] Failed to sync TodoWrite todos:', err instanceof Error ? err.message : err);
    }
  }

  private getSessionTimeoutMs(): number {
    const envTimeoutMs = Number(process.env.LETTA_SESSION_TIMEOUT_MS);
    if (Number.isFinite(envTimeoutMs) && envTimeoutMs > 0) {
      return envTimeoutMs;
    }
    return 60000;
  }

  private async withSessionTimeout<T>(
    promise: Promise<T>,
    label: string,
  ): Promise<T> {
    const timeoutMs = this.getSessionTimeoutMs();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private baseSessionOptions(canUseTool?: CanUseToolCallback) {
    return {
      permissionMode: 'default' as const,
      allowedTools: this.config.allowedTools,
      disallowedTools: [
        // Block built-in TodoWrite -- it requires interactive approval (fails
        // silently during heartbeats) and writes to the CLI's own store rather
        // than lettabot's persistent heartbeat store.  The agent should use the
        // custom manage_todo tool instead.
        'TodoWrite',
        ...(this.config.disallowedTools || []),
      ],
      // Use the letta-code repo directory as CWD so the subprocess discovers
      // skills from .skills/ inside that repo (not from lettabot's workingDir,
      // which has no .skills/ directory). Precedence:
      //   1. LETTA_SESSION_CWD (explicit override)
      //   2. dirname(LETTA_CLI_PATH) when pointing at a local checkout
      //   3. this.config.workingDir (fallback)
      cwd: process.env.LETTA_SESSION_CWD
        || (process.env.LETTA_CLI_PATH ? dirname(process.env.LETTA_CLI_PATH) : null)
        || this.config.workingDir,
      tools: [createManageTodoTool(this.getTodoAgentKey())],
      // In bypassPermissions mode, canUseTool is only called for interactive
      // tools (AskUserQuestion, ExitPlanMode). When no callback is provided
      // (background triggers), the SDK auto-denies interactive tools.
      ...(canUseTool ? { canUseTool } : {}),
    };
  }

  // =========================================================================
  // AskUserQuestion formatting
  // =========================================================================

  /**
   * Format AskUserQuestion questions as a single channel message.
   * Displays each question with numbered options for the user to choose from.
   */
  private formatQuestionsForChannel(questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>): string {
    const parts: string[] = [];
    for (const q of questions) {
      parts.push(`**${q.question}**`);
      parts.push('');
      for (let i = 0; i < q.options.length; i++) {
        parts.push(`${i + 1}. **${q.options[i].label}**`);
        parts.push(`   ${q.options[i].description}`);
      }
      if (q.multiSelect) {
        parts.push('');
        parts.push('_(You can select multiple options)_');
      }
    }
    parts.push('');
    parts.push('_Reply with your choice (number, name, or your own answer)._');
    return parts.join('\n');
  }

  // =========================================================================
  // Session lifecycle helpers
  // =========================================================================

  /**
   * Execute parsed directives (reactions, etc.) via the channel adapter.
   * Returns true if any directive was successfully executed.
   */
  private async executeDirectives(
    directives: Directive[],
    adapter: ChannelAdapter,
    chatId: string,
    fallbackMessageId?: string,
  ): Promise<boolean> {
    let acted = false;
    for (const directive of directives) {
      if (directive.type === 'react') {
        const targetId = directive.messageId || fallbackMessageId;
        if (!adapter.addReaction) {
          console.warn(`[Bot] Directive react skipped: ${adapter.name} does not support addReaction`);
          continue;
        }
        if (targetId) {
          try {
            await adapter.addReaction(chatId, targetId, directive.emoji);
            acted = true;
            console.log(`[Bot] Directive: reacted with ${directive.emoji}`);
          } catch (err) {
            console.warn('[Bot] Directive react failed:', err instanceof Error ? err.message : err);
          }
        }
      }
    }
    return acted;
  }

  // =========================================================================
  // Conversation key resolution
  // =========================================================================

  /**
   * Resolve the conversation key for a channel message.
   * In shared mode returns "shared"; in per-channel mode returns the channel id.
   */
  private resolveConversationKey(channel: string): string {
    return this.config.conversationMode === 'per-channel' ? channel : 'shared';
  }

  /**
   * Resolve the conversation key for heartbeat/sendToAgent.
   */
  private resolveHeartbeatConversationKey(): string {
    if (this.config.conversationMode !== 'per-channel') return 'shared';

    const hb = this.config.heartbeatConversation || 'last-active';
    if (hb === 'dedicated') return 'heartbeat';
    if (hb === 'last-active') {
      // Use the last channel the user messaged on
      const target = this.store.lastMessageTarget;
      return target ? target.channel : 'shared';
    }
    // Explicit channel name (e.g., "telegram")
    return hb;
  }

  // =========================================================================
  // Session lifecycle (per-key)
  // =========================================================================

  /**
   * Return the persistent session for the given conversation key,
   * creating and initializing it if needed.
   */
  private async ensureSessionForKey(key: string): Promise<LettaSession> {
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const opts = this.baseSessionOptions(this.sessionCanUseTool);
    let session: LettaSession;

    // In per-channel mode, look up per-key conversation ID.
    // In shared mode (key === "shared"), use the legacy single conversationId.
    const convId = key === 'shared'
      ? this.store.conversationId
      : this.store.getConversationId(key);

    if (convId === 'default' && this.store.agentId) {
      // Letta 0.16.x can fail on explicit --default in stream-json mode.
      // Use --agent only (no --new/--conversation) to bind default conversation.
      process.env.LETTA_AGENT_ID = this.store.agentId;
      session = new LettaSession({ ...opts, agentId: this.store.agentId });
    } else if (convId) {
      process.env.LETTA_AGENT_ID = this.store.agentId || undefined;
      session = resumeSession(convId, opts);
    } else if (this.store.agentId) {
      process.env.LETTA_AGENT_ID = this.store.agentId;
      session = createSession(this.store.agentId, opts);
    } else {
      // Create new agent -- persist immediately so we don't orphan it on later failures
      console.log('[Bot] Creating new agent');
      const newAgentId = await createAgent({
        systemPrompt: SYSTEM_PROMPT,
        memory: loadMemoryBlocks(this.config.agentName),
      });
      const currentBaseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';
      this.store.setAgent(newAgentId, currentBaseUrl);
      console.log('[Bot] Saved new agent ID:', newAgentId);

      if (this.config.agentName) {
        updateAgentName(newAgentId, this.config.agentName).catch(() => {});
      }
      installSkillsToAgent(newAgentId, this.config.skills);

      session = createSession(newAgentId, opts);
    }

    // Initialize eagerly so the subprocess is ready before the first send()
    console.log(`[Bot] Initializing session subprocess (key=${key})...`);
    try {
      await this.withSessionTimeout(session.initialize(), `Session initialize (key=${key})`);
      console.log(`[Bot] Session subprocess ready (key=${key})`);
      this.sessions.set(key, session);
      return session;
    } catch (error) {
      // Close immediately so failed initialization cannot leak a subprocess.
      session.close();
      throw error;
    }
  }

  /** Legacy convenience: resolve key from shared/per-channel mode and delegate. */
  private async ensureSession(): Promise<LettaSession> {
    return this.ensureSessionForKey('shared');
  }

  /**
   * Destroy session(s). If key provided, destroys only that key.
   * If key is undefined, destroys ALL sessions.
   */
  private invalidateSession(key?: string): void {
    if (key) {
      const session = this.sessions.get(key);
      if (session) {
        console.log(`[Bot] Invalidating session (key=${key})`);
        session.close();
        this.sessions.delete(key);
      }
    } else {
      for (const [k, session] of this.sessions) {
        console.log(`[Bot] Invalidating session (key=${k})`);
        session.close();
      }
      this.sessions.clear();
    }
  }

  /**
   * Pre-warm the session subprocess at startup. Call after config/agent is loaded.
   */
  async warmSession(): Promise<void> {
    if (!this.store.agentId && !this.store.conversationId) return;
    try {
      // In shared mode, warm the single session. In per-channel mode, warm nothing
      // (sessions are created on first message per channel).
      if (this.config.conversationMode !== 'per-channel') {
        await this.ensureSessionForKey('shared');
      }
    } catch (err) {
      console.warn('[Bot] Session pre-warm failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Persist conversation ID after a successful session result.
   * Agent ID and first-run setup are handled eagerly in ensureSessionForKey().
   *
   * fallbackConvId: use when session.conversationId is null because the CLI emits
   * conversation_id in result messages but not in the init message for new sessions.
   */
  private persistSessionState(session: LettaSession, convKey?: string, fallbackConvId?: string): void {
    // Agent ID already persisted in ensureSessionForKey() on creation.
    // Here we only update if the server returned a different one (shouldn't happen).
    if (session.agentId && session.agentId !== this.store.agentId) {
      const currentBaseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';
      this.store.setAgent(session.agentId, currentBaseUrl, session.conversationId || fallbackConvId || undefined);
      console.log('[Bot] Agent ID updated:', session.agentId);
    } else {
      const effectiveConvId = session.conversationId || fallbackConvId || null;
      if (effectiveConvId) {
        // In per-channel mode, persist per-key. In shared mode, use legacy field.
        if (convKey && convKey !== 'shared') {
          const existing = this.store.getConversationId(convKey);
          if (effectiveConvId !== existing) {
            this.store.setConversationId(convKey, effectiveConvId);
            console.log(`[Bot] Conversation ID updated (key=${convKey}):`, effectiveConvId);
          }
        } else if (effectiveConvId !== this.store.conversationId) {
          this.store.conversationId = effectiveConvId;
          console.log('[Bot] Conversation ID updated:', effectiveConvId);
        }
      }
    }
  }

  /**
   * Send a message and return a deduplicated stream.
   * 
   * Handles:
   * - Persistent session reuse (subprocess stays alive across messages)
   * - CONFLICT recovery from orphaned approvals (retry once)
   * - Conversation-not-found fallback (create new conversation)
   * - Tool call deduplication
   * - Session persistence after result
   */
  private async runSession(
    message: SendMessage,
    options: { retried?: boolean; canUseTool?: CanUseToolCallback; convKey?: string } = {},
  ): Promise<{ session: LettaSession; stream: () => AsyncGenerator<StreamMsg> }> {
    const { retried = false, canUseTool, convKey = 'shared' } = options;

    // Update the per-message callback before sending
    this.currentCanUseTool = canUseTool;

    let session = await this.ensureSessionForKey(convKey);

    // Resolve the conversation ID for this key (for error recovery)
    const convId = convKey === 'shared'
      ? this.store.conversationId
      : this.store.getConversationId(convKey);

    // Send message with fallback chain
    const MAX_BUSY_RETRIES = 3;
    const BUSY_RETRY_DELAY_MS = 8000; // 8s, 16s, 32s
    let busyRetries = 0;

    const trySend = async (): Promise<void> => {
      try {
        await this.withSessionTimeout(session.send(message), `Session send (key=${convKey})`);
      } catch (error) {
        if (isConversationBusyError(error) && busyRetries < MAX_BUSY_RETRIES) {
          busyRetries++;
          const delay = BUSY_RETRY_DELAY_MS * 2 ** (busyRetries - 1);
          console.log(`[Bot] Conversation busy (attempt ${busyRetries}/${MAX_BUSY_RETRIES}), retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          return trySend();
        }
        throw error;
      }
    };

    try {
      await trySend();
    } catch (error) {
      // 409 CONFLICT from orphaned approval
      if (!retried && isApprovalConflictError(error) && this.store.agentId && convId) {
        console.log('[Bot] CONFLICT detected - attempting orphaned approval recovery...');
        this.invalidateSession(convKey);
        const result = await recoverOrphanedConversationApproval(
          this.store.agentId,
          convId
        );
        if (result.recovered) {
          console.log(`[Bot] Recovery succeeded (${result.details}), retrying...`);
          return this.runSession(message, { retried: true, canUseTool, convKey });
        }
        console.error(`[Bot] Orphaned approval recovery failed: ${result.details}`);
        throw error;
      }

      // Conversation/agent not found - try creating a new conversation.
      // Only retry on errors that indicate missing conversation/agent, not
      // on auth, network, or protocol errors (which would just fail again).
      if (this.store.agentId && isConversationMissingError(error)) {
        console.warn(`[Bot] Conversation not found (key=${convKey}), creating a new conversation...`);
        this.invalidateSession(convKey);
        if (convKey !== 'shared') {
          this.store.clearConversation(convKey);
        } else {
          this.store.conversationId = null;
        }
        session = await this.ensureSessionForKey(convKey);
        try {
          await this.withSessionTimeout(session.send(message), `Session send retry (key=${convKey})`);
        } catch (retryError) {
          this.invalidateSession(convKey);
          throw retryError;
        }
      } else {
        // Unknown error -- invalidate so we get a fresh subprocess next time
        this.invalidateSession(convKey);
        throw error;
      }
    }

    // Persist conversation ID immediately after successful send, before streaming.
    this.persistSessionState(session, convKey);

    // Return session and a deduplicated stream generator
    const lastToolCallSignatures = new Map<string, string>();
    const self = this;
    const capturedConvKey = convKey; // Capture for closure

    async function* dedupedStream(): AsyncGenerator<StreamMsg> {
      for await (const raw of session.stream()) {
        const msg = raw as StreamMsg;

        // Allow progressive tool argument chunks through while still suppressing
        // exact duplicate repeats from the transport layer.
        if (msg.type === 'tool_call') {
          const id = msg.toolCallId;
          if (id) {
            const signature = JSON.stringify([
              msg.toolName || '',
              msg.toolInput ?? null,
              msg.uuid || '',
            ]);
            const previousSignature = lastToolCallSignatures.get(id);
            if (previousSignature === signature) continue;
            lastToolCallSignatures.set(id, signature);
          }
        }

        if (msg.type === 'result') {
          const resultConvId = typeof msg.conversationId === 'string' ? msg.conversationId : undefined;
          self.persistSessionState(session, capturedConvKey, resultConvId);
        }

        yield msg;

        if (msg.type === 'result') {
          break;
        }
      }
    }

    return { session, stream: dedupedStream };
  }

  // =========================================================================
  // Channel management
  // =========================================================================

  registerChannel(adapter: ChannelAdapter): void {
    adapter.onMessage = (msg) => this.handleMessage(msg, adapter);
    adapter.onCommand = (cmd) => this.handleCommand(cmd, adapter.id);
    this.channels.set(adapter.id, adapter);
    console.log(`Registered channel: ${adapter.name}`);
  }
  
  setGroupBatcher(batcher: GroupBatcher, intervals: Map<string, number>, instantGroupIds?: Set<string>, listeningGroupIds?: Set<string>): void {
    this.groupBatcher = batcher;
    this.groupIntervals = intervals;
    if (instantGroupIds) {
      this.instantGroupIds = instantGroupIds;
    }
    if (listeningGroupIds) {
      this.listeningGroupIds = listeningGroupIds;
    }
    console.log('[Bot] Group batcher configured');
  }

  processGroupBatch(msg: InboundMessage, adapter: ChannelAdapter): void {
    const count = msg.batchedMessages?.length || 0;
    console.log(`[Bot] Group batch: ${count} messages from ${msg.channel}:${msg.chatId}`);
    const effective = (count === 1 && msg.batchedMessages)
      ? msg.batchedMessages[0]
      : msg;

    // Legacy listeningGroups fallback (new mode-based configs set isListeningMode in adapters)
    if (effective.isListeningMode === undefined) {
      const isListening = this.listeningGroupIds.has(`${msg.channel}:${msg.chatId}`)
        || (msg.serverId && this.listeningGroupIds.has(`${msg.channel}:${msg.serverId}`));
      if (isListening && !msg.wasMentioned) {
        effective.isListeningMode = true;
      }
    }

    if (this.config.conversationMode === 'per-channel') {
      const convKey = this.resolveConversationKey(effective.channel);
      this.enqueueForKey(convKey, effective, adapter);
    } else {
      this.messageQueue.push({ msg: effective, adapter });
      if (!this.processing) {
        this.processQueue().catch(err => console.error('[Queue] Fatal error in processQueue:', err));
      }
    }
  }

  // =========================================================================
  // Commands
  // =========================================================================

  private async handleCommand(command: string, channelId?: string): Promise<string | null> {
    console.log(`[Command] Received: /${command}`);
    switch (command) {
      case 'status': {
        const info = this.store.getInfo();
        const lines = [
          `*Status*`,
          `Agent ID: \`${info.agentId || '(none)'}\``,
          `Created: ${info.createdAt || 'N/A'}`,
          `Last used: ${info.lastUsedAt || 'N/A'}`,
          `Channels: ${Array.from(this.channels.keys()).join(', ')}`,
        ];
        return lines.join('\n');
      }
      case 'heartbeat': {
        if (!this.onTriggerHeartbeat) {
          return '⚠️ Heartbeat service not configured';
        }
        this.onTriggerHeartbeat().catch(err => {
          console.error('[Heartbeat] Manual trigger failed:', err);
        });
        return '⏰ Heartbeat triggered (silent mode - check server logs)';
      }
      case 'new':
      case 'reset': {
        const convKey = channelId ? this.resolveConversationKey(channelId) : undefined;
        const isNewCommand = command === 'new';
        if (convKey && convKey !== 'shared') {
          // Per-channel mode: only clear the conversation for this channel
          this.store.clearConversation(convKey);
          this.invalidateSession(convKey);
          console.log(`[Command] /${command} - conversation cleared for ${convKey}`);
          // Eagerly create the new session so we can report the conversation ID
          try {
            const session = await this.ensureSessionForKey(convKey);
            const newConvId = session.conversationId || '(pending)';
            this.persistSessionState(session, convKey);
            return `New conversation started for this channel: ${newConvId}\nOther channels are unaffected. (Agent memory is preserved.)`;
          } catch {
            return `Started a new conversation for this channel. Other channels are unaffected. (Agent memory is preserved.)`;
          }
        }

        // Shared mode + default conversation alias: reset server-side messages
        // to keep ADE and Telegram in sync on "Default".
        if (this.store.conversationId === 'default' && this.store.agentId) {
          const resetOk = await resetAgentMessages(this.store.agentId, true);
          if (!resetOk) {
            return 'Failed to reset Default conversation on Letta server. Try again in a moment.';
          }
          this.store.conversationId = 'default';
          this.store.resetRecoveryAttempts();
          this.invalidateSession('shared');
          console.log(`[Command] /${command} - reset default conversation on server`);
          try {
            const session = await this.ensureSessionForKey('shared');
            const conv = session.conversationId || 'default';
            this.persistSessionState(session, 'shared');
            return `Started a fresh Default conversation. Active conversation: ${conv}\n(Agent memory is preserved.)`;
          } catch {
            return 'Started a fresh Default conversation. (Agent memory is preserved.)';
          }
        }

        // Shared mode or no channel context: clear everything
        this.store.clearConversation();
        this.store.resetRecoveryAttempts();
        this.invalidateSession();
        console.log(`[Command] /${command} - all conversations cleared`);
        try {
          const session = await this.ensureSessionForKey('shared');
          const newConvId = session.conversationId || '(pending)';
          this.persistSessionState(session, 'shared');
          if (isNewCommand) {
            return `Started a new conversation: ${newConvId}\n(Agent memory is preserved.)`;
          }
          return `Conversation reset. New conversation: ${newConvId}\n(Agent memory is preserved.)`;
        } catch {
          if (isNewCommand) {
            return 'Started a new conversation. Send a message to continue. (Agent memory is preserved.)';
          }
          return 'Conversation reset. Send a message to start a new conversation. (Agent memory is preserved.)';
        }
      }
      default:
        return null;
    }
  }

  // =========================================================================
  // Start / Stop
  // =========================================================================
  
  async start(): Promise<void> {
    const startPromises = Array.from(this.channels.entries()).map(async ([id, adapter]) => {
      try {
        console.log(`Starting channel: ${adapter.name}...`);
        await adapter.start();
        console.log(`Started channel: ${adapter.name}`);
      } catch (e) {
        console.error(`Failed to start channel ${id}:`, e);
      }
    });
    await Promise.all(startPromises);
  }
  
  async stop(): Promise<void> {
    for (const adapter of this.channels.values()) {
      try {
        await adapter.stop();
      } catch (e) {
        console.error(`Failed to stop channel ${adapter.id}:`, e);
      }
    }
  }

  // =========================================================================
  // Approval recovery
  // =========================================================================
  
  private async attemptRecovery(maxAttempts = 2): Promise<{ recovered: boolean; shouldReset: boolean }> {
    if (!this.store.agentId) {
      return { recovered: false, shouldReset: false };
    }
    
    console.log('[Bot] Checking for pending approvals...');
    
    try {
      const pendingApprovals = await getPendingApprovals(
        this.store.agentId,
        this.store.conversationId || undefined
      );
      
      if (pendingApprovals.length === 0) {
        if (this.store.conversationId) {
          const convResult = await recoverOrphanedConversationApproval(
            this.store.agentId!,
            this.store.conversationId
          );
          if (convResult.recovered) {
            console.log(`[Bot] Conversation-level recovery succeeded: ${convResult.details}`);
            return { recovered: true, shouldReset: false };
          }
        }
        this.store.resetRecoveryAttempts();
        return { recovered: false, shouldReset: false };
      }
      
      const attempts = this.store.recoveryAttempts;
      if (attempts >= maxAttempts) {
        console.error(`[Bot] Recovery failed after ${attempts} attempts. Still have ${pendingApprovals.length} pending approval(s).`);
        return { recovered: false, shouldReset: true };
      }
      
      console.log(`[Bot] Found ${pendingApprovals.length} pending approval(s), attempting recovery (attempt ${attempts + 1}/${maxAttempts})...`);
      this.store.incrementRecoveryAttempts();
      
      for (const approval of pendingApprovals) {
        console.log(`[Bot] Rejecting approval for ${approval.toolName} (${approval.toolCallId})`);
        await rejectApproval(
          this.store.agentId,
          { toolCallId: approval.toolCallId, reason: 'Session was interrupted - retrying request' },
          this.store.conversationId || undefined
        );
      }
      
      const runIds = [...new Set(pendingApprovals.map(a => a.runId))];
      if (runIds.length > 0) {
        console.log(`[Bot] Cancelling ${runIds.length} active run(s)...`);
        await cancelRuns(this.store.agentId, runIds);
      }
      
      console.log('[Bot] Recovery completed');
      return { recovered: true, shouldReset: false };
      
    } catch (error) {
      console.error('[Bot] Recovery failed:', error);
      this.store.incrementRecoveryAttempts();
      return { recovered: false, shouldReset: this.store.recoveryAttempts >= maxAttempts };
    }
  }

  // =========================================================================
  // Message queue
  // =========================================================================
  
  private async handleMessage(msg: InboundMessage, adapter: ChannelAdapter): Promise<void> {
    // AskUserQuestion support: if the agent is waiting for a user answer,
    // intercept this message and resolve the pending promise instead of
    // queuing it for normal processing. This prevents a deadlock where
    // the stream is paused waiting for user input while the processing
    // flag blocks new messages from being handled.
    if (this.pendingQuestionResolver) {
      console.log(`[Bot] Intercepted message as AskUserQuestion answer from ${msg.userId}`);
      this.pendingQuestionResolver(msg.text || '');
      this.pendingQuestionResolver = null;
      return;
    }

    console.log(`[${msg.channel}] Message from ${msg.userId}: ${msg.text}`);

    if (msg.isGroup && this.groupBatcher) {
      const isInstant = this.instantGroupIds.has(`${msg.channel}:${msg.chatId}`)
        || (msg.serverId && this.instantGroupIds.has(`${msg.channel}:${msg.serverId}`));
      const debounceMs = isInstant ? 0 : (this.groupIntervals.get(msg.channel) ?? 5000);
      console.log(`[Bot] Group message routed to batcher (debounce=${debounceMs}ms, mentioned=${msg.wasMentioned}, instant=${!!isInstant})`);
      this.groupBatcher.enqueue(msg, adapter, debounceMs);
      return;
    }

    if (this.config.conversationMode === 'per-channel') {
      // Per-channel mode: messages on different channels can run in parallel.
      // Only serialize within the same conversation key.
      const convKey = this.resolveConversationKey(msg.channel);
      this.enqueueForKey(convKey, msg, adapter);
    } else {
      // Shared mode: single global queue (existing behavior)
      this.messageQueue.push({ msg, adapter });
      if (!this.processing) {
        this.processQueue().catch(err => console.error('[Queue] Fatal error in processQueue:', err));
      }
    }
  }

  /**
   * Enqueue a message for a specific conversation key.
   * Messages with the same key are serialized; different keys run in parallel.
   */
  private keyedQueues: Map<string, Array<{ msg: InboundMessage; adapter: ChannelAdapter }>> = new Map();

  private enqueueForKey(key: string, msg: InboundMessage, adapter: ChannelAdapter): void {
    let queue = this.keyedQueues.get(key);
    if (!queue) {
      queue = [];
      this.keyedQueues.set(key, queue);
    }
    queue.push({ msg, adapter });

    if (!this.processingKeys.has(key)) {
      this.processKeyedQueue(key).catch(err =>
        console.error(`[Queue] Fatal error in processKeyedQueue(${key}):`, err)
      );
    }
  }

  private async processKeyedQueue(key: string): Promise<void> {
    if (this.processingKeys.has(key)) return;
    this.processingKeys.add(key);

    const queue = this.keyedQueues.get(key);
    while (queue && queue.length > 0) {
      const { msg, adapter } = queue.shift()!;
      try {
        await this.processMessage(msg, adapter);
      } catch (error) {
        console.error(`[Queue] Error processing message (key=${key}):`, error);
      }
    }

    this.processingKeys.delete(key);
    this.keyedQueues.delete(key);
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.messageQueue.length === 0) return;
    
    this.processing = true;
    
    while (this.messageQueue.length > 0) {
      const { msg, adapter } = this.messageQueue.shift()!;
      try {
        await this.processMessage(msg, adapter);
      } catch (error) {
        console.error('[Queue] Error processing message:', error);
      }
    }
    
    console.log('[Queue] Finished processing all messages');
    this.processing = false;
  }

  // =========================================================================
  // processMessage - User-facing message handling
  // =========================================================================
  
  private async processMessage(msg: InboundMessage, adapter: ChannelAdapter, retried = false): Promise<void> {
    // Track timing and last target
    const debugTiming = !!process.env.LETTABOT_DEBUG_TIMING;
    const t0 = debugTiming ? performance.now() : 0;
    const lap = (label: string) => {
      if (debugTiming) console.log(`[Timing] ${label}: ${(performance.now() - t0).toFixed(0)}ms`);
    };
    const suppressDelivery = isResponseDeliverySuppressed(msg);
    this.lastUserMessageTime = new Date();

    // Skip heartbeat target update for listening mode (don't redirect heartbeats)
    if (!suppressDelivery) {
      this.store.lastMessageTarget = {
        channel: msg.channel,
        chatId: msg.chatId,
        messageId: msg.messageId,
        updatedAt: new Date().toISOString(),
      };
    }

    // Fire-and-forget typing indicator so session creation starts immediately
    if (!suppressDelivery) {
      adapter.sendTypingIndicator(msg.chatId).catch(() => {});
    }
    lap('typing indicator');

    // Pre-send approval recovery
    // Only run proactive recovery when previous failures were detected.
    // Clean-path messages skip straight to session creation (the 409 retry
    // in runSession() still catches stuck states reactively).
    const recovery = this.store.recoveryAttempts > 0
      ? await this.attemptRecovery()
      : { recovered: false, shouldReset: false };
    lap('recovery check');
    if (recovery.shouldReset) {
      if (!suppressDelivery) {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `(I had trouble processing that -- the session hit a stuck state and automatic recovery failed after ${this.store.recoveryAttempts} attempt(s). Please try sending your message again. If this keeps happening, /reset will clear the conversation for this channel.)`,
          threadId: msg.threadId,
        });
      }
      return;
    }

    // Format message with metadata envelope
    const prevTarget = this.store.lastMessageTarget;
    const isNewChatSession = !prevTarget || prevTarget.chatId !== msg.chatId || prevTarget.channel !== msg.channel;
    const sessionContext: SessionContextOptions | undefined = isNewChatSession ? {
      agentId: this.store.agentId || undefined,
      serverUrl: process.env.LETTA_BASE_URL || this.store.baseUrl || 'https://api.letta.com',
    } : undefined;

    const formattedText = msg.isBatch && msg.batchedMessages
      ? formatGroupBatchEnvelope(msg.batchedMessages, {}, msg.isListeningMode)
      : formatMessageEnvelope(msg, {}, sessionContext);
    const messageToSend = await buildMultimodalMessage(formattedText, msg);
    lap('format message');

    // Build AskUserQuestion-aware canUseTool callback with channel context.
    // In bypassPermissions mode, this callback is only invoked for interactive
    // tools (AskUserQuestion, ExitPlanMode) -- normal tools are auto-approved.
    const canUseTool: CanUseToolCallback = async (toolName, toolInput) => {
      if (toolName === 'AskUserQuestion') {
        const questions = (toolInput.questions || []) as Array<{
          question: string;
          header: string;
          options: Array<{ label: string; description: string }>;
          multiSelect: boolean;
        }>;
        const questionText = this.formatQuestionsForChannel(questions);
        console.log(`[Bot] AskUserQuestion: sending ${questions.length} question(s) to ${msg.channel}:${msg.chatId}`);
        await adapter.sendMessage({ chatId: msg.chatId, text: questionText, threadId: msg.threadId });

        // Wait for the user's next message (intercepted by handleMessage)
        const answer = await new Promise<string>((resolve) => {
          this.pendingQuestionResolver = resolve;
        });
        console.log(`[Bot] AskUserQuestion: received answer (${answer.length} chars)`);

        // Map the user's response to each question
        const answers: Record<string, string> = {};
        for (const q of questions) {
          answers[q.question] = answer;
        }
        return {
          behavior: 'allow' as const,
          updatedInput: { ...toolInput, answers },
        };
      }
      // All other interactive tools: allow by default
      return { behavior: 'allow' as const };
    };

    // Run session
    let session: LettaSession | null = null;
    try {
      const convKey = this.resolveConversationKey(msg.channel);
      const run = await this.runSession(messageToSend, { retried, canUseTool, convKey });
      lap('session send');
      session = run.session;

      // Stream response with delivery
      let response = '';
      let lastUpdate = 0; // Start at 0 so the first streaming edit fires immediately
      let messageId: string | null = null;
      const canEdit = adapter.supportsEditing?.() ?? true;
      let lastMsgType: string | null = null;
      let lastAssistantUuid: string | null = null;
      let sentAnyMessage = false;
      let receivedAnyData = false;
      let sawNonAssistantSinceLastUuid = false;
      const msgTypeCounts: Record<string, number> = {};
      const seenToolCallIds = new Set<string>(); // tracks distinct tool calls for loop detection
      const toolNameCounts: Record<string, number> = {}; // per-tool call counts for repetition detection
      const pendingServerToolCalls = new Map<string, PendingServerToolCall>();
      let attemptedToolContinuation = false;
      
      const finalizeMessage = async () => {
        // Parse and execute XML directives before sending
        if (response.trim()) {
          const { cleanText, directives } = parseDirectives(response);
          response = cleanText;
          if (await this.executeDirectives(directives, adapter, msg.chatId, msg.messageId)) {
            sentAnyMessage = true;
          }
        }

        // Check for no-reply AFTER directive parsing
        if (response.trim() === '<no-reply/>') {
          console.log('[Bot] Agent chose not to reply (no-reply marker)');
          sentAnyMessage = true;
          response = '';
          messageId = null;
          lastUpdate = Date.now();
          return;
        }

        if (!suppressDelivery && response.trim()) {
          try {
            const prefixed = this.prefixResponse(response);
            if (messageId) {
              await adapter.editMessage(msg.chatId, messageId, prefixed);
            } else {
              await adapter.sendMessage({ chatId: msg.chatId, text: prefixed, threadId: msg.threadId });
            }
            sentAnyMessage = true;
          } catch {
            if (messageId) sentAnyMessage = true;
          }
        }
        response = '';
        messageId = null;
        lastUpdate = Date.now();
      };
      
      const typingInterval = setInterval(() => {
        adapter.sendTypingIndicator(msg.chatId).catch(() => {});
      }, 4000);

      // Abort if no stream events arrive for too long (e.g. send_message_to_agent_and_wait_for_reply never returns).
      const STREAM_INACTIVITY_MS = Number(process.env.STREAM_INACTIVITY_TIMEOUT_MS) || 5 * 60 * 1000;
      let streamInactivityTimer: ReturnType<typeof setTimeout> | null = null;
      let streamTimedOut = false;
      const resetStreamInactivityTimer = () => {
        if (streamInactivityTimer) clearTimeout(streamInactivityTimer);
        streamInactivityTimer = setTimeout(() => {
          streamTimedOut = true;
          console.warn(`[Bot] Stream inactivity timeout after ${STREAM_INACTIVITY_MS}ms — closing session`);
          session?.close();
        }, STREAM_INACTIVITY_MS);
      };
      resetStreamInactivityTimer();

      try {
        let firstChunkLogged = false;
        for await (const streamMsg of run.stream()) {
          if (!firstChunkLogged) { lap('first stream chunk'); firstChunkLogged = true; }
          receivedAnyData = true;
          resetStreamInactivityTimer();
          msgTypeCounts[streamMsg.type] = (msgTypeCounts[streamMsg.type] || 0) + 1;
          appendToolArgFragment(pendingServerToolCalls, streamMsg);
          if (streamMsg.type === 'tool_result' && streamMsg.toolCallId) {
            pendingServerToolCalls.delete(streamMsg.toolCallId);
          }
          
          const preview = JSON.stringify(streamMsg).slice(0, 300);
          console.log(`[Stream] type=${streamMsg.type} ${preview}`);
          
          // Finalize incremental chunks only on channels that support live edits.
          // Without editing (e.g., Telegram + TTS), flushing here causes one-word fragment messages.
          // Exception: if we're transitioning into a tool_call and the accumulated text is
          // meta-only reasoning ("I should ...", "I need to ..."), discard it and reset
          // sentAnyMessage so the meta-only retry can still fire after the tool completes.
          if (canEdit && lastMsgType && lastMsgType !== streamMsg.type && response.trim() && streamMsg.type !== 'result') {
            if (streamMsg.type === 'tool_call' && isMetaOnlyResponse(response.trim())) {
              console.log('[Bot] Suppressing meta-only pre-tool reasoning text (will retry if tool produces no answer)');
              response = '';
              messageId = null;
              sentAnyMessage = false;
            } else {
              await finalizeMessage();
            }
          }
          
          // Tool loop detection — count distinct tool call IDs, not stream fragments.
          // A single tool call streams many argument chunks, each with type='tool_call',
          // so counting raw events would falsely trip on a single long send_message call.
          if (streamMsg.type === 'tool_call' && streamMsg.toolCallId && !seenToolCallIds.has(streamMsg.toolCallId)) {
            seenToolCallIds.add(streamMsg.toolCallId);
            // Also track per-tool-name counts to catch single-tool spirals early
            if (streamMsg.toolName) {
              toolNameCounts[streamMsg.toolName] = (toolNameCounts[streamMsg.toolName] ?? 0) + 1;
              // Blocking multi-agent tools get a much lower limit — each call can hang for minutes
              // and the loop is almost always a sign of a stuck conversation context, not useful retries.
              const isBlockingMultiAgentTool =
                streamMsg.toolName === 'send_message_to_agent_and_wait_for_reply';
              const maxPerTool = isBlockingMultiAgentTool ? 3 : 8;
              if (toolNameCounts[streamMsg.toolName] >= maxPerTool) {
                console.error(`[Bot] Agent stuck in ${streamMsg.toolName} loop (${toolNameCounts[streamMsg.toolName]} calls), aborting and resetting conversation`);
                session.abort().catch(() => {});
                // Auto-reset conversation so the next message starts fresh instead of
                // re-entering the same loop from the corrupted conversation history.
                const loopConvKey = this.resolveConversationKey(msg.channel);
                this.invalidateSession(loopConvKey);
                if (loopConvKey !== 'shared') {
                  this.store.clearConversation(loopConvKey);
                } else {
                  this.store.conversationId = null;
                }
                response = "(I got stuck in a tool loop and stopped. I've reset our conversation — please send your message again and I'll try a different approach.)";
                break;
              }
            }
          }
          const maxToolCalls = this.config.maxToolCalls ?? 15;
          if (streamMsg.type === 'tool_call' && seenToolCallIds.size >= maxToolCalls) {
            console.error(`[Bot] Agent stuck in tool loop (${seenToolCallIds.size} distinct tool calls), aborting and resetting conversation`);
            session.abort().catch(() => {});
            // Auto-reset conversation so the next message starts fresh
            const loopConvKey = this.resolveConversationKey(msg.channel);
            this.invalidateSession(loopConvKey);
            if (loopConvKey !== 'shared') {
              this.store.clearConversation(loopConvKey);
            } else {
              this.store.conversationId = null;
            }
            response = "(I got stuck in a tool loop and stopped. I've reset our conversation — please send your message again and I'll try a different approach.)";
            break;
          }

          // Log meaningful events with structured summaries
          if (streamMsg.type === 'tool_call') {
            this.syncTodoToolCall(streamMsg);
            console.log(`[Stream] >>> TOOL CALL: ${streamMsg.toolName || 'unknown'} (id: ${streamMsg.toolCallId?.slice(0, 12) || '?'})`);
            sawNonAssistantSinceLastUuid = true;
          } else if (streamMsg.type === 'tool_result') {
            console.log(`[Stream] <<< TOOL RESULT: error=${streamMsg.isError}, len=${(streamMsg as any).content?.length || 0}`);
            sawNonAssistantSinceLastUuid = true;
          } else if (streamMsg.type === 'assistant' && lastMsgType !== 'assistant') {
            console.log(`[Bot] Generating response...`);
          } else if (streamMsg.type === 'reasoning' && lastMsgType !== 'reasoning') {
            console.log(`[Bot] Reasoning...`);
            sawNonAssistantSinceLastUuid = true;
          } else if (streamMsg.type !== 'assistant') {
            sawNonAssistantSinceLastUuid = true;
          }

          // Broadcast live events to ThoughtBridge (best-effort, never throws)
          if (streamMsg.type === 'reasoning' && streamMsg.content) {
            ThoughtBroadcaster.broadcast({ kind: 'reasoning', text: streamMsg.content as string, agentId: this.store.agentId ?? undefined });
          } else if (streamMsg.type === 'tool_call' && streamMsg.toolName) {
            const args = typeof streamMsg.toolInput === 'string'
              ? streamMsg.toolInput
              : JSON.stringify(streamMsg.toolInput ?? {}).slice(0, 200);
            ThoughtBroadcaster.broadcast({ kind: 'tool_call', text: `→ ${streamMsg.toolName}(${args})`, agentId: this.store.agentId ?? undefined });
          } else if (streamMsg.type === 'tool_result') {
            const len = (streamMsg as any).content?.length ?? 0;
            ThoughtBroadcaster.broadcast({ kind: 'tool_result', text: `← result (${len} chars, error=${streamMsg.isError})`, agentId: this.store.agentId ?? undefined });
          }

          lastMsgType = streamMsg.type;
          
          if (streamMsg.type === 'assistant') {
            const msgUuid = streamMsg.uuid;
            if (msgUuid && lastAssistantUuid && msgUuid !== lastAssistantUuid) {
              if (canEdit && response.trim()) {
                if (!sawNonAssistantSinceLastUuid) {
                  console.warn(`[Stream] WARNING: Assistant UUID changed (${lastAssistantUuid.slice(0, 8)} -> ${msgUuid.slice(0, 8)}) with no visible tool_call/reasoning events between them. Tool call events may have been dropped by SDK transformMessage().`);
                }
                await finalizeMessage();
              }
              // Start tracking tool/reasoning visibility for the new assistant UUID.
              sawNonAssistantSinceLastUuid = false;
            } else if (msgUuid && !lastAssistantUuid) {
              // Clear any pre-assistant noise so the first UUID becomes a clean baseline.
              sawNonAssistantSinceLastUuid = false;
            }
            lastAssistantUuid = msgUuid || lastAssistantUuid;
            
            response += streamMsg.content || '';
            
            // Live-edit streaming for channels that support it
            // Hold back streaming edits while response could still be <no-reply/> or <actions> block
            const trimmed = response.trim();
            const mayBeHidden = '<no-reply/>'.startsWith(trimmed)
              || '<actions>'.startsWith(trimmed)
              || (trimmed.startsWith('<actions') && !trimmed.includes('</actions>'));
            // Strip any completed <actions> block from the streaming text
            const streamText = stripActionsBlock(response).trim();
            if (canEdit && !mayBeHidden && !suppressDelivery && streamText.length > 0 && Date.now() - lastUpdate > 500 && !isMetaOnlyResponse(streamText)) {
              try {
                const prefixedStream = this.prefixResponse(streamText);
                if (messageId) {
                  await adapter.editMessage(msg.chatId, messageId, prefixedStream);
                } else {
                  const result = await adapter.sendMessage({ chatId: msg.chatId, text: prefixedStream, threadId: msg.threadId });
                  messageId = result.messageId;
                  sentAnyMessage = true;
                }
              } catch (editErr) {
                console.warn('[Bot] Streaming edit failed:', editErr instanceof Error ? editErr.message : editErr);
              }
              lastUpdate = Date.now();
            }
          }
          
          if (streamMsg.type === 'result') {
            const resultText = typeof streamMsg.result === 'string' ? streamMsg.result : '';
            if (resultText.trim().length > 0) {
              response = resultText;
            }
            const hasResponse = response.trim().length > 0;
            const deliverableResponse = response.trim();
            // Check resultText directly as a safety valve: if the CLI result field has
            // non-meta content, treat the response as deliverable even when accumulated
            // streaming chunks were meta-only and shadowed the assignment above.
            const resultTextDeliverable =
              resultText.trim().length > 0 && !isMetaOnlyResponse(resultText.trim());
            const hasDeliverableResponse =
              (hasResponse && !isMetaOnlyResponse(deliverableResponse)) || resultTextDeliverable;
            const isTerminalError = streamMsg.success === false || !!streamMsg.error;
            console.log(`[Bot] Stream result: success=${streamMsg.success}, hasResponse=${hasResponse}, deliverable=${hasDeliverableResponse}, resultLen=${resultText.length}, responsePreview=${deliverableResponse.slice(0, 80)}`);
            console.log(`[Bot] Stream message counts:`, msgTypeCounts);
            if (streamMsg.error) {
              const detail = resultText.trim();
              const parts = [`error=${streamMsg.error}`];
              if (streamMsg.stopReason) parts.push(`stopReason=${streamMsg.stopReason}`);
              if (streamMsg.durationMs !== undefined) parts.push(`duration=${streamMsg.durationMs}ms`);
              if (streamMsg.conversationId) parts.push(`conv=${streamMsg.conversationId}`);
              if (detail) parts.push(`detail=${detail.slice(0, 300)}`);
              console.error(`[Bot] Result error: ${parts.join(', ')}`);
            }

            // Retry once when stream ends without any assistant text.
            // This catches both empty-success and terminal-error runs.
            // TODO(letta-code-sdk#31): Remove once SDK handles HITL approvals in bypassPermissions mode.
            // Only retry if we never sent anything to the user. hasResponse tracks
            // the current buffer, but finalizeMessage() clears it on type changes.
            // sentAnyMessage is the authoritative "did we deliver output" flag.
            if (
              streamMsg.success &&
              !hasDeliverableResponse &&
              !sentAnyMessage &&
              pendingServerToolCalls.size > 0 &&
              this.store.agentId
            ) {
              const pendingCalls: PendingMultiAgentToolCall[] = Array.from(
                pendingServerToolCalls.entries(),
              )
                .map(([toolCallId, info]) => ({
                  toolCallId,
                  toolName: info.toolName,
                  toolArgs: info.toolArgs,
                }))
                .filter((call) => call.toolName && call.toolArgs);

              // Tools that have client-side fallback handlers.
              // All others are server-side tools (e.g. web_fetch_exa, web_search_exa)
              // executed by the Letta server — skip client-side fallback for those.
              const CLIENT_SIDE_FALLBACK_TOOLS = new Set([
                'relay_message_to_chatgpt',
                'send_message_to_agent_async',
                'send_message_to_agent_and_wait_for_reply',
              ]);

              for (const call of pendingCalls) {
                if (!CLIENT_SIDE_FALLBACK_TOOLS.has(call.toolName)) {
                  // Server-side tool — already executed by Letta server.
                  // No client-side handler; skip to avoid misleading fallback attempts.
                  console.log(`[Bot] Skipping client-side fallback for server-side tool: ${call.toolName}`);
                  continue;
                }

                if (call.toolName === 'relay_message_to_chatgpt') {
                  try {
                    console.log(
                      `[Bot] Attempting ChatGPT relay fallback with args length=${call.toolArgs.length}`,
                    );
                    const relayResponse = await executeChatGptRelayFallback(
                      call.toolArgs,
                    );
                    if (relayResponse) {
                      response = relayResponse;
                      sentAnyMessage = false;
                      break;
                    }
                    console.warn(
                      `[Bot] ChatGPT relay fallback produced no response. argsPreview=${call.toolArgs.slice(0, 260)}`,
                    );
                  } catch (relayErr) {
                    console.warn(
                      '[Bot] ChatGPT relay fallback failed:',
                      relayErr instanceof Error ? relayErr.message : relayErr,
                    );
                  }
                  continue;
                }

                try {
                  console.log(
                    `[Bot] Attempting multi-agent fallback for ${call.toolName} with args length=${call.toolArgs.length}`,
                  );
                  const fallbackResponse = await executePendingMultiAgentToolCall(
                    call,
                    this.store.agentId,
                  );
                  if (fallbackResponse) {
                    response = fallbackResponse;
                    sentAnyMessage = false;
                    break;
                  } else {
                    console.warn(
                      `[Bot] Multi-agent fallback produced no response for ${call.toolName}. argsPreview=${call.toolArgs.slice(0, 260)}`,
                    );
                  }
                } catch (fallbackErr) {
                  console.warn(
                    '[Bot] Multi-agent fallback failed:',
                    fallbackErr instanceof Error
                      ? fallbackErr.message
                      : fallbackErr,
                  );
                }
              }
            }

            const hadToolActivityForResult =
              (msgTypeCounts['tool_call'] || 0) > 0 ||
              (msgTypeCounts['tool_result'] || 0) > 0;
            const hasRecoveredToolResponse =
              response.trim().length > 0 && !isMetaOnlyResponse(response.trim());
            if (
              streamMsg.success &&
              !hasRecoveredToolResponse &&
              !sentAnyMessage &&
              hadToolActivityForResult &&
              !attemptedToolContinuation
            ) {
              attemptedToolContinuation = true;
              console.log('[Bot] Empty response after tool workflow; requesting one continuation turn...');
              try {
                // Use a system-reminder to block further tool calls so the model
                // synthesizes an answer rather than looping on web_fetch_exa, etc.
                const continuationPrompt =
                  '<system-reminder>\n' +
                  'Do not call any tools for this response.\n' +
                  'Respond in plain text only.\n' +
                  '</system-reminder>\n\n' +
                  'Please provide the final user-visible answer to the previous message.';
                const continuation = await this.runSession(
                  continuationPrompt,
                  { retried: true, canUseTool, convKey },
                );
                for await (const continuationMsg of continuation.stream()) {
                  const continuationPreview = JSON.stringify(continuationMsg).slice(0, 300);
                  console.log(`[Stream:continuation] type=${continuationMsg.type} ${continuationPreview}`);
                  if (continuationMsg.type === 'tool_call') {
                    this.syncTodoToolCall(continuationMsg);
                  }
                  if (continuationMsg.type === 'assistant') {
                    response += continuationMsg.content || '';
                  }
                  if (continuationMsg.type === 'result') {
                    const continuationResultText =
                      typeof continuationMsg.result === 'string'
                        ? continuationMsg.result
                        : '';
                    if (continuationResultText.trim()) {
                      response = continuationResultText;
                    }
                    break;
                  }
                }
                if (isMetaOnlyResponse(response.trim())) {
                  console.warn(`[Bot] Continuation produced meta-only response (len=${response.length}); suppressing`);
                  response = '';
                }
              } catch (continuationErr) {
                console.warn(
                  '[Bot] Continuation after tool workflow failed:',
                  continuationErr instanceof Error
                    ? continuationErr.message
                    : continuationErr,
                );
              }
            }

            // If response is meta-only (reasoning text, no actual answer) and no tool
            // calls were pending, either retry once or suppress so the no-response
            // fallback fires — never deliver raw reasoning text to the user.
            if (
              streamMsg.success &&
              !hasDeliverableResponse &&
              !sentAnyMessage &&
              pendingServerToolCalls.size === 0 &&
              !attemptedToolContinuation
            ) {
              if (!retried) {
                console.log('[Bot] Meta-only result with no tool calls — retrying message...');
                this.invalidateSession(this.resolveConversationKey(msg.channel));
                session = null;
                clearInterval(typingInterval);
                return this.processMessage(msg, adapter, true);
              }
              // Already retried — clear so no-response fallback fires below
              console.warn('[Bot] Meta-only result on retry — suppressing to trigger no-response fallback');
              response = '';
            }

            const hasRecoveredResponse = response.trim().length > 0;
            const nothingDelivered = !hasRecoveredResponse && !sentAnyMessage;
            const shouldRetryForEmptyResult =
              streamMsg.success &&
              resultText === '' &&
              nothingDelivered &&
              !attemptedToolContinuation;
            const shouldRetryForErrorResult = isTerminalError && nothingDelivered;
            if (shouldRetryForEmptyResult || shouldRetryForErrorResult) {
              if (shouldRetryForEmptyResult) {
                console.error(`[Bot] Warning: Agent returned empty result with no response. stopReason=${streamMsg.stopReason || 'N/A'}, conv=${streamMsg.conversationId || 'N/A'}`);
              }
              if (shouldRetryForErrorResult) {
                console.error(`[Bot] Warning: Agent returned terminal error (error=${streamMsg.error}, stopReason=${streamMsg.stopReason || 'N/A'}) with no response.`);
              }

              const retryConvKey = this.resolveConversationKey(msg.channel);
              const retryConvId = retryConvKey === 'shared'
                ? this.store.conversationId
                : this.store.getConversationId(retryConvKey);
              if (!retried && this.store.agentId && retryConvId) {
                const reason = shouldRetryForErrorResult ? 'error result' : 'empty result';
                console.log(`[Bot] ${reason} - attempting orphaned approval recovery...`);
                this.invalidateSession(retryConvKey);
                session = null;
                clearInterval(typingInterval);
                const convResult = await recoverOrphanedConversationApproval(
                  this.store.agentId,
                  retryConvId
                );
                if (convResult.recovered) {
                  console.log(`[Bot] Recovery succeeded (${convResult.details}), retrying message...`);
                  return this.processMessage(msg, adapter, true);
                }
                console.warn(`[Bot] No orphaned approvals found: ${convResult.details}`);

                // Some client-side approval failures do not surface as pending approvals.
                // Retry once anyway in case the previous run terminated mid-tool cycle.
                if (shouldRetryForErrorResult) {
                  console.log('[Bot] Retrying once after terminal error (no orphaned approvals detected)...');
                  return this.processMessage(msg, adapter, true);
                }
              }
            }

            if (isTerminalError && !response.trim() && !sentAnyMessage) {
              const err = streamMsg.error || 'unknown error';
              const reason = streamMsg.stopReason ? ` [${streamMsg.stopReason}]` : '';
              response = `(Agent run failed: ${err}${reason}. Try sending your message again.)`;
            }
            
            break;
          }
        }
      } finally {
        if (streamInactivityTimer) clearTimeout(streamInactivityTimer);
        clearInterval(typingInterval);
        adapter.stopTypingIndicator?.(msg.chatId)?.catch(() => {});
      }
      lap('stream complete');

      if (streamTimedOut && !response.trim() && !sentAnyMessage) {
        response = '(Scissari timed out waiting for a response — a tool call took too long. Please try again, or send /new to start a fresh conversation.)';
      }

      const hadToolActivity =
        (msgTypeCounts['tool_call'] || 0) > 0 ||
        (msgTypeCounts['tool_result'] || 0) > 0;

      if (!sentAnyMessage && hadToolActivity && !response.trim() && !attemptedToolContinuation) {
        console.log('[Bot] Empty response after tool workflow; requesting one continuation turn...');
        try {
          const continuation = await this.runSession(
            '<system-reminder>\n' +
            'Do not call any tools for this response.\n' +
            'Respond in plain text only.\n' +
            '</system-reminder>\n\n' +
            'Please provide the final user-visible answer to the previous message.',
            { retried: true, canUseTool, convKey },
          );
          for await (const continuationMsg of continuation.stream()) {
            const preview = JSON.stringify(continuationMsg).slice(0, 300);
            console.log(`[Stream:continuation] type=${continuationMsg.type} ${preview}`);
            if (continuationMsg.type === 'tool_call') {
              this.syncTodoToolCall(continuationMsg);
            }
            if (continuationMsg.type === 'assistant') {
              response += continuationMsg.content || '';
            }
            if (continuationMsg.type === 'result') {
              const resultText =
                typeof continuationMsg.result === 'string'
                  ? continuationMsg.result
                  : '';
              if (resultText.trim()) {
                response = resultText;
              }
              break;
            }
          }
          if (isMetaOnlyResponse(response.trim())) {
            console.warn(`[Bot] Continuation produced meta-only response (len=${response.length}); suppressing`);
            response = '';
          }
        } catch (continuationErr) {
          console.warn(
            '[Bot] Continuation after tool workflow failed:',
            continuationErr instanceof Error
              ? continuationErr.message
              : continuationErr,
          );
        }
      }

      // Parse and execute XML directives (e.g. <actions><react emoji="eyes" /></actions>)
      if (response.trim()) {
        const { cleanText, directives } = parseDirectives(response);
        response = cleanText;
        if (await this.executeDirectives(directives, adapter, msg.chatId, msg.messageId)) {
          sentAnyMessage = true;
        }
      }

      // Handle no-reply marker AFTER directive parsing
      if (response.trim() === '<no-reply/>') {
        sentAnyMessage = true;
        response = '';
      }

      // Detect unsupported multimodal
      if (Array.isArray(messageToSend) && response.includes('[Image omitted]')) {
        console.warn('[Bot] Model does not support images -- consider a vision-capable model or features.inlineImages: false');
      }

      // Listening mode: agent processed for memory, suppress response delivery
      if (suppressDelivery) {
        console.log(`[Bot] Listening mode: processed ${msg.channel}:${msg.chatId} for memory (response suppressed)`);
        return;
      }

      lap('directives done');
      // Send final response
      if (response.trim()) {
        const prefixedFinal = this.prefixResponse(response);
        try {
          if (messageId) {
            await adapter.editMessage(msg.chatId, messageId, prefixedFinal);
          } else {
            await adapter.sendMessage({ chatId: msg.chatId, text: prefixedFinal, threadId: msg.threadId });
          }
          sentAnyMessage = true;
          this.store.resetRecoveryAttempts();
        } catch {
          // Edit failed -- send as new message so user isn't left with truncated text
          try {
            await adapter.sendMessage({ chatId: msg.chatId, text: prefixedFinal, threadId: msg.threadId });
            sentAnyMessage = true;
            this.store.resetRecoveryAttempts();
          } catch (retryError) {
            console.error('[Bot] Retry send also failed:', retryError);
          }
        }
      }
      
      lap('message delivered');
      // Handle no response
      if (!sentAnyMessage) {
        if (!receivedAnyData) {
          console.error('[Bot] Stream received NO DATA - possible stuck state');
          await adapter.sendMessage({ 
            chatId: msg.chatId, 
            text: '(No response received -- the connection may have dropped or the server may be busy. Please try again. If this persists, /reset will start a fresh conversation.)', 
            threadId: msg.threadId 
          });
        } else {
          if (hadToolActivity) {
            console.log('[Bot] Agent had tool activity but no assistant message - returning visible fallback');
            await adapter.sendMessage({
              chatId: msg.chatId,
              text: '(I ran into an issue completing that request — the response was lost during a tool workflow. Please try again.)',
              threadId: msg.threadId,
            });
          } else {
            await adapter.sendMessage({ 
              chatId: msg.chatId, 
              text: '(The agent processed your message but didn\'t produce a visible response. This can happen with certain prompts. Try rephrasing or sending again.)', 
              threadId: msg.threadId 
            });
          }
        }
      }
      
    } catch (error) {
      console.error('[Bot] Error processing message:', error);
      try {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          threadId: msg.threadId,
        });
      } catch (sendError) {
        console.error('[Bot] Failed to send error message to channel:', sendError);
      }
    } finally {
      // Session stays alive for reuse -- only invalidated on errors
    }
  }

  // =========================================================================
  // sendToAgent - Background triggers (heartbeats, cron, webhooks)
  // =========================================================================
  
  /**
   * Acquire the appropriate lock for a conversation key.
   * In per-channel mode with a dedicated key, no lock needed (parallel OK).
   * In per-channel mode with a channel key, wait for that key's queue.
   * In shared mode, use the global processing flag.
   */
  private async acquireLock(convKey: string): Promise<boolean> {
    if (convKey === 'heartbeat') return false; // No lock needed

    if (this.config.conversationMode === 'per-channel') {
      while (this.processingKeys.has(convKey)) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      this.processingKeys.add(convKey);
    } else {
      while (this.processing) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      this.processing = true;
    }
    return true;
  }

  private releaseLock(convKey: string, acquired: boolean): void {
    if (!acquired) return;
    if (this.config.conversationMode === 'per-channel') {
      this.processingKeys.delete(convKey);
    } else {
      this.processing = false;
      this.processQueue();
    }
  }

  async sendToAgent(
    text: string,
    _context?: TriggerContext
  ): Promise<string> {
    const convKey = this.resolveHeartbeatConversationKey();
    const acquired = await this.acquireLock(convKey);
    
    try {
      const collectResponse = async (
        streamFactory: () => AsyncGenerator<StreamMsg>,
      ): Promise<{ response: string; hadToolCall: boolean }> => {
        let response = '';
        let hadToolCall = false;
        for await (const msg of streamFactory()) {
          console.log(`[sendToAgent] type=${msg.type} content=${JSON.stringify(String(msg.content || msg.result || '').slice(0, 120))}`);
          // Broadcast live events to ThoughtBridge (same as processMessage path)
          if (msg.type === 'reasoning' && msg.content) {
            ThoughtBroadcaster.broadcast({ kind: 'reasoning', text: msg.content as string, agentId: this.store.agentId ?? undefined });
          } else if (msg.type === 'tool_call' && msg.toolName) {
            const args = typeof msg.toolInput === 'string' ? msg.toolInput : JSON.stringify(msg.toolInput ?? {}).slice(0, 200);
            ThoughtBroadcaster.broadcast({ kind: 'tool_call', text: `→ ${msg.toolName}(${args})`, agentId: this.store.agentId ?? undefined });
          } else if (msg.type === 'tool_result') {
            const len = (msg as any).content?.length ?? 0;
            ThoughtBroadcaster.broadcast({ kind: 'tool_result', text: `← result (${len} chars, error=${msg.isError})`, agentId: this.store.agentId ?? undefined });
          }
          if (msg.type === 'tool_call') {
            hadToolCall = true;
            this.syncTodoToolCall(msg);
          }
          if (msg.type === 'assistant') {
            response += msg.content || '';
          }
          if (msg.type === 'result') {
            // TODO(letta-code-sdk#31): Remove once SDK handles HITL approvals in bypassPermissions mode.
            if (msg.success === false || msg.error) {
              const detail = typeof msg.result === 'string' ? msg.result.trim() : '';
              throw new Error(detail ? `Agent run failed: ${msg.error || 'error'} (${detail})` : `Agent run failed: ${msg.error || 'error'}`);
            }
            // Prefer terminal result text over earlier assistant scaffolding
            // (e.g., "I will call the tool"), matching processMessage().
            if (typeof msg.result === 'string' && msg.result.trim()) {
              response = msg.result;
            }
            break;
          }
        }
        if (isMetaOnlyResponse(response.trim())) {
          console.warn(`[sendToAgent] suppressing meta-only response (len=${response.length})`);
          response = '';
        }
        return { response, hadToolCall };
      };

      try {
        const { stream } = await this.runSession(text, { convKey });
        let { response, hadToolCall } = await collectResponse(stream);

        if (!response.trim() && hadToolCall) {
          console.log('[sendToAgent] Empty response after tool workflow; requesting one continuation turn...');
          const continuation = await this.runSession(
            '<system-reminder>\n' +
            'Do not call any tools for this response.\n' +
            'Respond in plain text only.\n' +
            '</system-reminder>\n\n' +
            'Please provide the final user-visible answer to the previous message.',
            { convKey },
          );
          const continuationResult = await collectResponse(continuation.stream);
          response = continuationResult.response;
        }

        console.log(`[sendToAgent] final response length=${response.length}`);
        return response;
      } catch (error) {
        // Invalidate on stream errors so next call gets a fresh subprocess
        this.invalidateSession(convKey);
        throw error;
      }
    } finally {
      this.releaseLock(convKey, acquired);
    }
  }

  /**
   * Stream a message to the agent, yielding chunks as they arrive.
   * Same lifecycle as sendToAgent() but yields StreamMsg instead of accumulating.
   */
  async *streamToAgent(
    text: string,
    _context?: TriggerContext
  ): AsyncGenerator<StreamMsg> {
    const convKey = this.resolveHeartbeatConversationKey();
    const acquired = await this.acquireLock(convKey);

    try {
      const { stream } = await this.runSession(text, { convKey });

      try {
        for await (const msg of stream()) {
          // Mirror ThoughtBroadcaster calls for SSE streaming path
          if (msg.type === 'reasoning' && msg.content) {
            ThoughtBroadcaster.broadcast({ kind: 'reasoning', text: msg.content as string, agentId: this.store.agentId ?? undefined });
          } else if (msg.type === 'tool_call' && msg.toolName) {
            const args = typeof msg.toolInput === 'string' ? msg.toolInput : JSON.stringify(msg.toolInput ?? {}).slice(0, 200);
            ThoughtBroadcaster.broadcast({ kind: 'tool_call', text: `→ ${msg.toolName}(${args})`, agentId: this.store.agentId ?? undefined });
          } else if (msg.type === 'tool_result') {
            ThoughtBroadcaster.broadcast({ kind: 'tool_result', text: `← result (${(msg as any).content?.length ?? 0} chars)`, agentId: this.store.agentId ?? undefined });
          }
          yield msg;
        }
      } catch (error) {
        this.invalidateSession(convKey);
        throw error;
      }
    } finally {
      this.releaseLock(convKey, acquired);
    }
  }

  // =========================================================================
  // Channel delivery + status
  // =========================================================================
  
  async deliverToChannel(
    channelId: string,
    chatId: string,
    options: {
      text?: string;
      filePath?: string;
      kind?: 'image' | 'file';
    }
  ): Promise<string | undefined> {
    const adapter = this.channels.get(channelId);
    if (!adapter) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    if (options.filePath) {
      if (typeof adapter.sendFile !== 'function') {
        throw new Error(`Channel ${channelId} does not support file sending`);
      }
      const result = await adapter.sendFile({
        chatId,
        filePath: options.filePath,
        caption: options.text,
        kind: options.kind,
      });
      return result.messageId;
    }

    if (options.text) {
      const result = await adapter.sendMessage({ chatId, text: this.prefixResponse(options.text) });
      return result.messageId;
    }

    throw new Error('Either text or filePath must be provided');
  }

  getStatus(): { agentId: string | null; conversationId: string | null; channels: string[] } {
    return {
      agentId: this.store.agentId,
      conversationId: this.store.conversationId,
      channels: Array.from(this.channels.keys()),
    };
  }
  
  setAgentId(agentId: string): void {
    this.store.agentId = agentId;
    console.log(`[Bot] Agent ID set to: ${agentId}`);
  }
  
  reset(): void {
    this.store.reset();
    console.log('Agent reset');
  }
  
  getLastMessageTarget(): { channel: string; chatId: string } | null {
    return this.store.lastMessageTarget || null;
  }
  
  getLastUserMessageTime(): Date | null {
    return this.lastUserMessageTime;
  }
}

function isShellExecutionTool(toolName: string): boolean {
  return ['Bash', 'ShellCommand', 'executor_run'].includes(toolName);
}

function getShellCommandFromToolInput(toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const input = toolInput as Record<string, unknown>;
  for (const key of ['command', 'cmd']) {
    const value = input[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

function isDangerousShellCommandForHostedBot(command: string): boolean {
  const normalized = command.replace(/\\\n/g, ' ').replace(/\s+/g, ' ').trim();
  return /\bpkill\s+-f\b/.test(normalized) || /\bkillall\b/.test(normalized);
}
