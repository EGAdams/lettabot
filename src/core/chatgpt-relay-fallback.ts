import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ChatGptRelayArgs = {
  message: string;
  browser_server_url?: string;
  executor_url?: string;
  executor_token?: string;
  timeout_seconds?: number;
  poll_seconds?: number;
  stability_checks?: number;
  max_total_seconds?: number;
};

export function parseChatGptRelayArgs(rawArgs: string): ChatGptRelayArgs | null {
  const parse = (text: string): ChatGptRelayArgs | null => {
    try {
      const parsed = JSON.parse(text) as Partial<ChatGptRelayArgs>;
      if (typeof parsed.message !== 'string' || !parsed.message.trim()) {
        return null;
      }
      return {
        message: parsed.message,
        browser_server_url: parsed.browser_server_url || '',
        executor_url: parsed.executor_url || '',
        executor_token: parsed.executor_token || '',
        timeout_seconds: Number(parsed.timeout_seconds || 180),
        poll_seconds: Number(parsed.poll_seconds || 10),
        stability_checks: Number(parsed.stability_checks || 2),
        max_total_seconds: Number(parsed.max_total_seconds || 600),
      };
    } catch {
      return null;
    }
  };

  const direct = parse(rawArgs);
  if (direct) return direct;

  const repaired = rawArgs
    .replace(/^\{"message:/, '{"message":"')
    .replace(/":,/g, '":"",')
    .replace(/":}/g, '":""}');
  return parse(repaired);
}

function resolveToolPath(): string {
  const explicit = process.env.CHATGPT_RELAY_TOOL_PATH;
  if (explicit) return explicit;

  const cliPath = process.env.LETTA_CLI_PATH;
  if (cliPath) {
    return join(dirname(cliPath), 'browser_tools', 'letta_chatgpt_relay_tool.py');
  }

  return '/home/adamsl/letta-code/browser_tools/letta_chatgpt_relay_tool.py';
}

export async function executeChatGptRelayFallback(rawArgs: string): Promise<string | null> {
  const args = parseChatGptRelayArgs(rawArgs);
  if (!args) return null;

  const toolPath = resolveToolPath();
  const script = `
import importlib.util
import json
import sys

payload = json.loads(sys.argv[1])
spec = importlib.util.spec_from_file_location("letta_chatgpt_relay_tool", sys.argv[2])
module = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(module)
print(module.relay_message_to_chatgpt(**payload))
`;

  const { stdout } = await execFileAsync(
    process.env.PYTHON || 'python3',
    ['-c', script, JSON.stringify(args), toolPath],
    {
      timeout: Math.max(10, (args.max_total_seconds || 600) + 30) * 1000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  const raw = stdout.trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as { response?: unknown; message?: unknown; status?: unknown };
    if (typeof parsed.response === 'string' && parsed.response.trim()) {
      return parsed.response.trim();
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return `ChatGPT relay failed (${String(parsed.status || 'unknown')}): ${parsed.message.trim()}`;
    }
  } catch {
    return raw;
  }

  return null;
}
