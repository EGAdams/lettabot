/**
 * OAuth 2.0 utilities for ChatGPT OAuth authentication
 * Uses Authorization Code Flow with PKCE and local callback server
 * Compatible with Codex CLI authentication flow
 *
 * Ported from @letta-ai/letta-code
 */

import http from 'node:http';

export const OPENAI_OAUTH_CONFIG = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorizationUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  defaultPort: 1455,
  callbackPath: '/auth/callback',
  scope: 'openid profile email offline_access',
} as const;

export interface OpenAITokens {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

export interface OAuthCallbackResult {
  code: string;
  state: string;
}

/**
 * Generate PKCE code verifier (43-128 characters of unreserved URI characters)
 */
export function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

/**
 * Generate PKCE code challenge from verifier using SHA-256
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Generate cryptographically secure state parameter
 */
export function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function base64UrlEncode(buffer: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...buffer));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) throw new Error('Invalid JWT format');
  const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return JSON.parse(atob(padded));
}

/**
 * Extract ChatGPT Account ID from id_token JWT
 */
export function extractAccountIdFromToken(token: string): string {
  const payload = decodeJwtPayload(token);
  const authClaim = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
  if (authClaim && typeof authClaim.chatgpt_account_id === 'string') {
    return authClaim.chatgpt_account_id;
  }
  throw new Error('chatgpt_account_id not found in token claims');
}

/**
 * Generate PKCE code verifier and challenge
 */
export async function generatePKCE(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  return { codeVerifier, codeChallenge };
}

/**
 * Start a local HTTP server to receive OAuth callback
 */
export function startLocalOAuthServer(
  expectedState: string,
  port = OPENAI_OAUTH_CONFIG.defaultPort,
): Promise<{ result: OAuthCallbackResult; server: http.Server }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '', `http://localhost:${port}`);
      if (url.pathname !== OPENAI_OAUTH_CONFIG.callbackPath) {
        res.writeHead(404).end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end(`Error: ${error}`);
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Missing code or state');
        reject(new Error('Missing authorization code or state parameter'));
        return;
      }
      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('State mismatch');
        reject(new Error('State mismatch'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' }).end(
        '<html><body><h2>Authorization successful!</h2><p>You can close this window and return to LettaBot.</p><script>setTimeout(()=>window.close(),2000)</script></body></html>',
      );
      resolve({ result: { code, state }, server });
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use. Close any app using it and try again.`));
      } else {
        reject(err);
      }
    });

    server.listen(port, '127.0.0.1');

    setTimeout(() => {
      server.close();
      reject(new Error('OAuth timeout - no callback received within 5 minutes'));
    }, 5 * 60 * 1000);
  });
}

/**
 * Start OAuth flow - returns authorization URL and PKCE values
 */
export async function startOpenAIOAuth(port = OPENAI_OAUTH_CONFIG.defaultPort): Promise<{
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}> {
  const state = generateState();
  const { codeVerifier, codeChallenge } = await generatePKCE();
  const redirectUri = `http://localhost:${port}${OPENAI_OAUTH_CONFIG.callbackPath}`;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OPENAI_OAUTH_CONFIG.clientId,
    redirect_uri: redirectUri,
    scope: OPENAI_OAUTH_CONFIG.scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs',
  });

  return {
    authorizationUrl: `${OPENAI_OAUTH_CONFIG.authorizationUrl}?${params.toString()}`,
    state,
    codeVerifier,
    redirectUri,
  };
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<OpenAITokens> {
  const response = await fetch(OPENAI_OAUTH_CONFIG.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OPENAI_OAUTH_CONFIG.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to exchange code for tokens (HTTP ${response.status}): ${await response.text()}`);
  }

  return (await response.json()) as OpenAITokens;
}
