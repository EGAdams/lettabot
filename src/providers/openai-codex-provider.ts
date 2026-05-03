/**
 * Manage the ChatGPT OAuth provider on the Letta backend
 * Uses provider_type "chatgpt_oauth" - backend handles request transformation
 * (transforms OpenAI API format → ChatGPT backend API format)
 *
 * Ported from @letta-ai/letta-code
 */

import { LETTA_API_URL } from '../auth/oauth.js';

export const OPENAI_CODEX_PROVIDER_NAME = 'chatgpt-plus-pro';
export const CHATGPT_OAUTH_PROVIDER_TYPE = 'chatgpt_oauth';

export interface ChatGPTOAuthConfig {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  account_id: string;
  expires_at: number; // Unix timestamp in milliseconds
}

interface ProviderResponse {
  id: string;
  name: string;
  provider_type: string;
  api_key?: string;
  base_url?: string;
}

function getLettaConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.LETTA_BASE_URL || LETTA_API_URL;
  const apiKey = process.env.LETTA_API_KEY || '';
  return { baseUrl, apiKey };
}

function getLettaBotHeaders(apiKey?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Letta-Source': 'lettabot',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

async function providersRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const { baseUrl, apiKey } = getLettaConfig();
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: getLettaBotHeaders(apiKey),
    ...(body && { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 403) {
      try {
        const errorData = JSON.parse(errorText);
        if (typeof errorData.error === 'string' && errorData.error.includes('only available for pro or enterprise')) {
          throw new Error('PLAN_UPGRADE_REQUIRED');
        }
      } catch (e) {
        if (e instanceof Error && e.message === 'PLAN_UPGRADE_REQUIRED') throw e;
      }
    }
    throw new Error(`Provider API error (${response.status}): ${errorText}`);
  }

  const text = await response.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

export async function listProviders(): Promise<ProviderResponse[]> {
  try {
    return await providersRequest<ProviderResponse[]>('GET', '/v1/providers');
  } catch {
    return [];
  }
}

export async function getOpenAICodexProvider(): Promise<ProviderResponse | null> {
  const providers = await listProviders();
  return providers.find(p => p.name === OPENAI_CODEX_PROVIDER_NAME) || null;
}

export async function createOpenAICodexProvider(config: ChatGPTOAuthConfig): Promise<ProviderResponse> {
  const apiKeyJson = JSON.stringify({
    access_token: config.access_token,
    id_token: config.id_token,
    refresh_token: config.refresh_token,
    account_id: config.account_id,
    expires_at: config.expires_at,
  });

  return providersRequest<ProviderResponse>('POST', '/v1/providers', {
    name: OPENAI_CODEX_PROVIDER_NAME,
    provider_type: CHATGPT_OAUTH_PROVIDER_TYPE,
    api_key: apiKeyJson,
  });
}

export async function updateOpenAICodexProvider(
  providerId: string,
  config: ChatGPTOAuthConfig,
): Promise<ProviderResponse> {
  const apiKeyJson = JSON.stringify({
    access_token: config.access_token,
    id_token: config.id_token,
    refresh_token: config.refresh_token,
    account_id: config.account_id,
    expires_at: config.expires_at,
  });

  return providersRequest<ProviderResponse>('PATCH', `/v1/providers/${providerId}`, {
    api_key: apiKeyJson,
  });
}

export async function createOrUpdateOpenAICodexProvider(config: ChatGPTOAuthConfig): Promise<ProviderResponse> {
  const existing = await getOpenAICodexProvider();
  if (existing) {
    return updateOpenAICodexProvider(existing.id, config);
  }
  return createOpenAICodexProvider(config);
}

export async function removeOpenAICodexProvider(): Promise<void> {
  const existing = await getOpenAICodexProvider();
  if (existing) {
    await providersRequest<void>('DELETE', `/v1/providers/${existing.id}`);
  }
}
