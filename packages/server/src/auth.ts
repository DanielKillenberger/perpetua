/**
 * OAuth flow routes.
 *
 * POST /auth/:provider/start       → { auth_url, expires_in }
 * GET  /auth/:provider/callback    → HTML success/error page
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomBytes } from 'crypto';
import { getProvider } from './providers.js';
import type { ITokenStore } from 'perpetua/store/types';
import { requireApiKey } from './middleware.js';

interface AuthParams {
  provider: string;
}

interface StartBody {
  account?: string;
}

interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function successHtml(provider: string, account: string): string {
  const safeProvider = escapeHtml(provider);
  const safeAccount = escapeHtml(account);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Connected — Perpetua</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 20px; text-align: center; }
    h1 { color: #16a34a; }
    p { color: #555; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>✅ Connected!</h1>
  <p>Provider <strong>${safeProvider}</strong> (account: <code>${safeAccount}</code>) has been linked to Perpetua.</p>
  <p>You can close this tab.</p>
</body>
</html>`;
}

function errorHtml(message: string): string {
  const safeMessage = escapeHtml(message);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Error — Perpetua</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 20px; text-align: center; }
    h1 { color: #dc2626; }
    p { color: #555; }
  </style>
</head>
<body>
  <h1>❌ Authentication Failed</h1>
  <p>${safeMessage}</p>
</body>
</html>`;
}

export function registerAuthRoutes(app: FastifyInstance, store: ITokenStore): void {
  /**
   * POST /auth/:provider/start
   * Body (JSON): { account?: string }
   * Returns: { auth_url: string, expires_in: number }
   */
  app.post<{ Params: AuthParams; Body: StartBody }>(
    '/auth/:provider/start',
    {
      preHandler: requireApiKey,
      schema: {
        params: {
          type: 'object',
          required: ['provider'],
          properties: {
            provider: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-zA-Z0-9_-]+$' },
          },
          additionalProperties: false,
        },
        body: {
          type: 'object',
          properties: {
            account: { type: 'string', minLength: 1, maxLength: 128 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request: FastifyRequest<{ Params: AuthParams; Body: StartBody }>, reply: FastifyReply) => {
      const { provider } = request.params;
      const account = (request.body as StartBody)?.account ?? 'default';

      const providerCfg = getProvider(provider);
      if (!providerCfg) {
        return reply.code(404).send({
          error: 'UnknownProvider',
          message: `Provider "${provider}" is not registered.`,
        });
      }

      const baseUrl = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
      const redirectUri = `${baseUrl}/auth/${provider}/callback`;
      const state = randomBytes(24).toString('hex');

      // Persist state so callback can verify it
      await store.saveOAuthState(state, provider, account);

      const authUrl = new URL(providerCfg.auth_url);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', providerCfg.client_id);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('scope', providerCfg.scopes.join(' '));
      authUrl.searchParams.set('state', state);

      // Apply any provider-specific extra params (e.g. access_type=offline for Google)
      if (providerCfg.extra_params) {
        for (const [key, value] of Object.entries(providerCfg.extra_params)) {
          authUrl.searchParams.set(key, value);
        }
      }

      return reply.send({
        auth_url: authUrl.toString(),
        redirect_uri: redirectUri,
        expires_in: 600, // state valid 10 minutes
      });
    },
  );

  /**
   * GET /auth/:provider/callback
   * Query: code, state, error
   * Returns: HTML page
   */
  app.get<{ Params: AuthParams; Querystring: CallbackQuery }>(
    '/auth/:provider/callback',
    {
      schema: {
        params: {
          type: 'object',
          required: ['provider'],
          properties: {
            provider: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-zA-Z0-9_-]+$' },
          },
          additionalProperties: false,
        },
        querystring: {
          type: 'object',
          properties: {
            code: { type: 'string', minLength: 1, maxLength: 2048 },
            state: { type: 'string', minLength: 1, maxLength: 256 },
            error: { type: 'string', minLength: 1, maxLength: 256 },
          },
          additionalProperties: true,
        },
      },
    },
    async (request: FastifyRequest<{ Params: AuthParams; Querystring: CallbackQuery }>, reply: FastifyReply) => {
      const { provider } = request.params;
      const { code, state, error } = request.query;

      if (error) {
        return reply
          .code(400)
          .type('text/html')
          .send(errorHtml(`OAuth error: ${error}`));
      }

      if (!code || !state) {
        return reply
          .code(400)
          .type('text/html')
          .send(errorHtml('Missing code or state parameter.'));
      }

      // Verify state
      const stateData = await store.consumeOAuthState(state);
      if (!stateData || stateData.provider !== provider) {
        return reply
          .code(400)
          .type('text/html')
          .send(errorHtml('Invalid or expired state. Please try again.'));
      }

      const { account } = stateData;

      const providerCfg = getProvider(provider);
      if (!providerCfg) {
        return reply
          .code(404)
          .type('text/html')
          .send(errorHtml(`Unknown provider: ${provider}`));
      }

      const baseUrl = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
      const redirectUri = `${baseUrl}/auth/${provider}/callback`;

      // Exchange code for tokens
      let tokenData: {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };

      try {
        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: providerCfg.client_id,
          client_secret: providerCfg.client_secret,
          redirect_uri: redirectUri,
        });

        const res = await fetch(providerCfg.token_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });

        if (!res.ok) {
          throw new Error(`Token exchange failed with status ${res.status}`);
        }

        tokenData = (await res.json()) as typeof tokenData;
      } catch (err) {
        app.log.error({ provider, err }, 'Token exchange failed');
        return reply
          .code(500)
          .type('text/html')
          .send(errorHtml('Token exchange failed. Check server logs.'));
      }

      if (!tokenData.refresh_token) {
        return reply
          .code(500)
          .type('text/html')
          .send(errorHtml('No refresh token returned. Ensure you requested offline access.'));
      }

      const expiresAt = tokenData.expires_in
        ? Math.floor(Date.now() / 1000) + tokenData.expires_in
        : undefined;

      await store.storeToken({
        provider,
        account,
        refreshToken: tokenData.refresh_token,
        accessToken: tokenData.access_token,
        expiresAt,
        scopes: tokenData.scope ?? providerCfg.scopes.join(' '),
      });

      app.log.info({ provider, account }, 'OAuth connection established');

      return reply.type('text/html').send(successHtml(provider, account));
    },
  );
}
