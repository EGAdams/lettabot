/**
 * ThoughtBroadcaster — singleton WebSocket producer for the Thought Bridge.
 *
 * Connects to ws://localhost:8765, announces role:producer, then fans out
 * ThoughtEvent JSON as Scissari's stream events arrive.
 *
 * Design:
 *   - Fire-and-forget: every send is best-effort; never throws, never blocks bot
 *   - Auto-reconnects with exponential back-off (max 30s)
 *   - Disabled silently if THOUGHT_BRIDGE_DISABLED=1 or bridge is unreachable
 */

export interface ThoughtEvent {
  type: 'thought';
  kind: 'reasoning' | 'assistant' | 'tool_call' | 'tool_result' | 'system' | 'error';
  text: string;
  timestamp: number;
  agentId?: string;
}

const BRIDGE_URL = process.env.THOUGHT_BRIDGE_URL ?? 'ws://localhost:8765';
const DISABLED = process.env.THOUGHT_BRIDGE_DISABLED === '1';
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const MAX_RECONNECT_ATTEMPTS = optionalPositiveInt(process.env.THOUGHT_BRIDGE_MAX_RECONNECTS, 5);

class ThoughtBroadcasterImpl {
  private ws: WebSocket | null = null;
  private ready = false;
  private queue: string[] = [];
  private retryIndex = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private disabledAfterFailures = false;

  constructor() {
    if (!DISABLED) this._connect();
  }

  broadcast(event: Omit<ThoughtEvent, 'type' | 'timestamp'>): void {
    if (DISABLED || this.disabledAfterFailures) return;
    const payload = JSON.stringify({
      type: 'thought',
      timestamp: Date.now(),
      ...event,
    } satisfies ThoughtEvent);

    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this._send(payload);
    } else {
      // Buffer up to 50 events; drop oldest if overflowing
      this.queue.push(payload);
      if (this.queue.length > 50) this.queue.shift();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
    this.ready = false;
  }

  private _connect(): void {
    if (this.stopped) return;
    try {
      const ws = new WebSocket(BRIDGE_URL);
      this.ws = ws;

      ws.addEventListener('open', () => {
        // Announce producer role
        ws.send(JSON.stringify({ role: 'producer' }));
        this.ready = true;
        this.retryIndex = 0;
        // Flush buffered events
        for (const msg of this.queue.splice(0)) {
          this._send(msg);
        }
        console.log(`[ThoughtBroadcaster] Connected to bridge at ${BRIDGE_URL}`);
      });

      ws.addEventListener('close', () => {
        this.ready = false;
        const wasTracked = this.ws === ws;
        this.ws = null;
        // Only reconnect if error handler hasn't already scheduled one
        if (wasTracked && !this.stopped) this._scheduleReconnect();
      });

      ws.addEventListener('error', () => {
        // Node.js 22 built-in WebSocket does not fire 'close' on connection
        // refusal — only 'error'. Schedule reconnect here so retry loop works.
        this.ready = false;
        if (this.ws === ws && !this.stopped) {
          this.ws = null;  // Mark handled so 'close' handler won't double-schedule
          this._scheduleReconnect();
        }
      });
    } catch (e) {
      if (!this.stopped) this._scheduleReconnect();
    }
  }

  private _send(payload: string): void {
    try {
      this.ws?.send(payload);
    } catch (e) {
      console.debug(`[ThoughtBroadcaster] Send error: ${e}`);
    }
  }

  private _scheduleReconnect(): void {
    if (this.retryTimer || this.disabledAfterFailures) return;
    if (MAX_RECONNECT_ATTEMPTS !== null && this.retryIndex >= MAX_RECONNECT_ATTEMPTS) {
      this.disabledAfterFailures = true;
      this.queue = [];
      console.warn(
        `[ThoughtBroadcaster] Bridge unavailable at ${BRIDGE_URL}; disabling after ${this.retryIndex} reconnect attempts. ` +
          'Set THOUGHT_BRIDGE_DISABLED=1 to disable explicitly, or THOUGHT_BRIDGE_MAX_RECONNECTS=0 to retry forever.',
      );
      return;
    }
    const delay = RECONNECT_DELAYS_MS[Math.min(this.retryIndex, RECONNECT_DELAYS_MS.length - 1)];
    this.retryIndex++;
    console.debug(`[ThoughtBroadcaster] Reconnecting in ${delay}ms (attempt ${this.retryIndex})`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this._connect();
    }, delay);
  }
}

export const ThoughtBroadcaster = new ThoughtBroadcasterImpl();

function optionalPositiveInt(value: string | undefined, fallback: number): number | null {
  if (value === '0') return null;
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
