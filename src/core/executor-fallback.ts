import type { PendingMultiAgentToolCall } from './multi-agent-fallback.js';

interface ExecutorRunArgs {
  command: string;
  cwd?: string;
}

/**
 * Execute executor_run via HTTP to the local executor service.
 * The executor service is typically running on 127.0.0.1:8787.
 * This is a fallback when the Letta server streams executor_run as a tool_call
 * but doesn't execute it server-side (Mode C).
 */
export async function executeExecutorRunFallback(
  call: PendingMultiAgentToolCall,
): Promise<string | null> {
  if (call.toolName !== 'executor_run') {
    return null;
  }

  let args: ExecutorRunArgs;
  try {
    args = JSON.parse(call.toolArgs);
  } catch (e) {
    console.error('[Bot] Failed to parse executor_run args:', e);
    return 'executor_run: invalid JSON arguments';
  }

  const { command, cwd } = args;
  if (!command || typeof command !== 'string') {
    return 'executor_run: missing required command argument';
  }

  try {
    console.log('[Bot] Executing executor_run via HTTP: command=', command.slice(0, 60));

    const executorUrl = new URL('http://127.0.0.1:8787/run');
    executorUrl.searchParams.set('command', command);
    if (cwd) {
      executorUrl.searchParams.set('cwd', cwd);
    }

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 30000);

    try {
      const response = await fetch(executorUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortController.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const text = await response.text();
        console.error('[Bot] executor_run HTTP error: status=', response.status, 'body=', text.slice(0, 200));
        return 'executor_run HTTP ' + response.status + ': ' + text;
      }

      const result = await response.json() as any;
      const output = result.stdout || result.stderr || '';
      return output || '(executor_run completed)';
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        console.error('[Bot] executor_run HTTP timeout');
        return 'executor_run error: request timeout (30s)';
      }
      throw fetchError;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[Bot] executor_run fallback failed:', msg);
    return 'executor_run error: ' + msg;
  }
}
