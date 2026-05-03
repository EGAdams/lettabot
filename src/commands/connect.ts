/**
 * lettabot connect - Connect external providers
 *
 * Subcommands:
 *   lettabot connect codex   - Connect ChatGPT Plus/Pro via OAuth (uses gpt-5.2-codex model)
 *   lettabot disconnect codex - Remove ChatGPT OAuth provider
 */

import {
  startOpenAIOAuth,
  startLocalOAuthServer,
  exchangeCodeForTokens,
  extractAccountIdFromToken,
  OPENAI_OAUTH_CONFIG,
} from '../auth/openai-oauth.js';
import {
  createOrUpdateOpenAICodexProvider,
  removeOpenAICodexProvider,
  getOpenAICodexProvider,
  OPENAI_CODEX_PROVIDER_NAME,
} from '../providers/openai-codex-provider.js';

async function openBrowser(url: string): Promise<void> {
  try {
    const { default: open } = await import('open');
    const subprocess = await open(url, { wait: false });
    subprocess.on('error', () => {});
  } catch {
    // Browser open failed - user can open manually
  }
}

export async function connectCodex(): Promise<void> {
  const p = await import('@clack/prompts');

  p.intro('Connect ChatGPT Plus/Pro (OAuth)');

  // Check if already connected
  const existing = await getOpenAICodexProvider();
  if (existing) {
    p.log.info(`Already connected as provider: ${OPENAI_CODEX_PROVIDER_NAME}`);
    const reauth = await p.confirm({ message: 'Re-authenticate to refresh tokens?', initialValue: false });
    if (p.isCancel(reauth) || !reauth) {
      p.outro('No changes made.');
      return;
    }
  }

  // Start OAuth flow
  const spinner = p.spinner();
  spinner.start('Starting OAuth flow...');

  let authorizationUrl: string;
  let state: string;
  let codeVerifier: string;
  let redirectUri: string;

  try {
    ({ authorizationUrl, state, codeVerifier, redirectUri } = await startOpenAIOAuth(
      OPENAI_OAUTH_CONFIG.defaultPort,
    ));
    spinner.stop('OAuth flow ready');
  } catch (err) {
    spinner.stop('Failed to start OAuth flow');
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  p.log.info(`Opening browser for authorization...`);
  p.log.message(`If the browser doesn't open automatically, visit:\n\n  ${authorizationUrl}\n`);

  // Start callback server before opening browser
  const serverPromise = startLocalOAuthServer(state, OPENAI_OAUTH_CONFIG.defaultPort);
  await openBrowser(authorizationUrl);

  const waitSpinner = p.spinner();
  waitSpinner.start('Waiting for authorization in browser...');

  let code: string;
  try {
    const { result, server } = await serverPromise;
    server.close();
    code = result.code;
    waitSpinner.stop('Authorization received');
  } catch (err) {
    waitSpinner.stop('Authorization failed');
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Exchange code for tokens
  const tokenSpinner = p.spinner();
  tokenSpinner.start('Exchanging code for tokens...');

  try {
    const tokens = await exchangeCodeForTokens(code, codeVerifier, redirectUri);
    tokenSpinner.stop('Tokens received');

    const providerSpinner = p.spinner();
    providerSpinner.start('Registering ChatGPT OAuth provider with Letta...');

    const accountId = extractAccountIdFromToken(tokens.id_token);
    await createOrUpdateOpenAICodexProvider({
      access_token: tokens.access_token,
      id_token: tokens.id_token,
      refresh_token: tokens.refresh_token,
      account_id: accountId,
      expires_at: Date.now() + tokens.expires_in * 1000,
    });

    providerSpinner.stop('Provider registered');
    p.log.success(`Connected! Provider: ${OPENAI_CODEX_PROVIDER_NAME}`);
    p.log.message(
      'You can now use gpt-5.2-codex model:\n' +
      '  lettabot model set chatgpt-plus-pro/gpt-5.2-codex',
    );
    p.outro('Done');
  } catch (err) {
    tokenSpinner.stop('Failed');
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export async function disconnectCodex(): Promise<void> {
  const p = await import('@clack/prompts');

  p.intro('Disconnect ChatGPT OAuth');

  const existing = await getOpenAICodexProvider();
  if (!existing) {
    p.log.info('No ChatGPT OAuth provider connected.');
    return;
  }

  const confirmed = await p.confirm({
    message: `Remove provider "${OPENAI_CODEX_PROVIDER_NAME}"?`,
    initialValue: false,
  });

  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel('Cancelled');
    return;
  }

  const spinner = p.spinner();
  spinner.start('Removing provider...');
  await removeOpenAICodexProvider();
  spinner.stop('Provider removed');
  p.outro('Disconnected from ChatGPT OAuth');
}

export async function connectCommand(subCommand?: string): Promise<void> {
  switch (subCommand) {
    case 'codex':
    case 'chatgpt':
      await connectCodex();
      break;
    default:
      console.log('Usage: lettabot connect <codex>');
      console.log('       lettabot disconnect <codex>');
      console.log('');
      console.log('  codex    Connect ChatGPT Plus/Pro via OAuth');
      process.exit(1);
  }
}

export async function disconnectCommand(subCommand?: string): Promise<void> {
  switch (subCommand) {
    case 'codex':
    case 'chatgpt':
      await disconnectCodex();
      break;
    default:
      console.log('Usage: lettabot disconnect <codex>');
      process.exit(1);
  }
}
