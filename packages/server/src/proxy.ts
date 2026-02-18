/**
 * Core proxy handler: ALL /proxy/:provider/*
 *
 * Flow:
 *  1. Validate API key
 *  2. Resolve provider → base_url
 *  3. Load token from store (provider + ?account=)
 *  4. Refresh token if needed
 *  5. Forward request with Authorization: Bearer <access_token>
 *  6. Stream response back
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireApiKey } from './middleware.js';
import { getProvider } from './providers.js';
import type { ITokenStore } from 'perpetua/store/types';

interface ProxyParams {
  provider: string;
  '*': string;
}

interface ProxyQuery {
  account?: string;
  [key: string]: string | string[] | undefined;
}

/** Refresh an access token using the provider's token endpoint. */
async function refreshAccessToken(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in?: number;
    refresh_token?: string;
  };

  const expiresAt = Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600);
  return { accessToken: data.access_token, expiresAt };
}

/** Strip specific query params from a URLSearchParams object. */
function stripQueryParams(query: ProxyQuery, ...keys: string[]): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (keys.includes(k)) continue;
    if (Array.isArray(v)) {
      for (const val of v) params.append(k, val);
    } else if (v !== undefined) {
      params.set(k, v);
    }
  }
  const str = params.toString();
  return str ? `?${str}` : '';
}

/** Headers we should NOT forward from client to upstream. */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'authorization', // We'll add our own
]);

/** Headers we should NOT forward from upstream to client. */
const SKIP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding', // fetch decodes for us
]);

export function registerProxyRoutes(app: FastifyInstance, store: ITokenStore): void {
  // Match ALL methods and ALL paths under /proxy/:provider/
  app.all<{ Params: ProxyParams; Querystring: ProxyQuery }>(
    '/proxy/:provider/*',
    { preHandler: requireApiKey },
    async (request: FastifyRequest<{ Params: ProxyParams; Querystring: ProxyQuery }>, reply: FastifyReply) => {
      const { provider, '*': wildcardPath } = request.params;
      const accountParam = request.query.account as string | undefined;

      // 1. Resolve provider
      const providerCfg = getProvider(provider);
      if (!providerCfg) {
        return reply.code(404).send({
          error: 'UnknownProvider',
          message: `Provider "${provider}" is not registered. Check providers.yml.`,
        });
      }

      // 2. Load token
      // If ?account= is specified, look up exactly that account.
      // Otherwise: try "default" first, then fall back to the only existing connection.
      let tokenRecord;
      let account: string;
      if (accountParam) {
        tokenRecord = await store.getToken(provider, accountParam);
        account = accountParam;
      } else {
        const defaultNamed = await store.getToken(provider, 'default');
        if (defaultNamed) {
          tokenRecord = defaultNamed;
          account = 'default';
        } else {
          tokenRecord = await store.getDefaultToken(provider);
          account = tokenRecord?.account ?? '';
        }
      }

      if (!tokenRecord) {
        return reply.code(404).send({
          error: 'NoConnection',
          message: `No connection found for provider "${provider}"` +
            (accountParam ? `, account "${accountParam}"` : '') +
            `. Connect via POST /auth/${provider}/start` +
            (accountParam ? '' : `, then use ?account=<name> if you have multiple connections`) +
            `.`,
        });
      }

      // 3. Refresh token if expired or expiring within 5 minutes
      const nowSec = Math.floor(Date.now() / 1000);
      const shouldRefresh =
        !tokenRecord.accessToken ||
        (tokenRecord.expiresAt !== null && tokenRecord.expiresAt - nowSec < 300);

      if (shouldRefresh) {
        try {
          const { accessToken, expiresAt } = await refreshAccessToken(
            providerCfg.token_url,
            providerCfg.client_id,
            providerCfg.client_secret,
            tokenRecord.refreshToken,
          );
          await store.updateAccessToken(provider, account, accessToken, expiresAt);
          tokenRecord = { ...tokenRecord, accessToken, expiresAt };
        } catch (err) {
          app.log.error({ provider, account, err }, 'Token refresh failed in proxy');
          return reply.code(401).send({
            error: 'TokenRefreshFailed',
            message: `Could not refresh access token for "${provider}/${account}". ` +
              `Re-authenticate via POST /auth/${provider}/start.`,
          });
        }
      }

      // 4. Build upstream URL
      const upstreamPath = `/${wildcardPath}`;
      const queryString = stripQueryParams(request.query, 'account');
      const upstreamUrl = `${providerCfg.base_url}${upstreamPath}${queryString}`;

      // 5. Build forwarded headers
      const forwardHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(request.headers)) {
        if (HOP_BY_HOP_HEADERS.has(k.toLowerCase())) continue;
        if (typeof v === 'string') forwardHeaders[k] = v;
        else if (Array.isArray(v)) forwardHeaders[k] = v.join(', ');
      }
      forwardHeaders['authorization'] = `Bearer ${tokenRecord.accessToken}`;

      // 6. Determine body
      const hasBody = ['POST', 'PUT', 'PATCH'].includes(request.method.toUpperCase());
      const bodyContent = hasBody ? (request.body as string | Record<string, unknown> | undefined) : undefined;

      // 7. Forward request
      let upstreamRes: Response;
      try {
        upstreamRes = await fetch(upstreamUrl, {
          method: request.method,
          headers: forwardHeaders,
          body: bodyContent
            ? (typeof bodyContent === 'string' ? bodyContent : JSON.stringify(bodyContent))
            : undefined,
          redirect: 'follow',
        });
      } catch (err) {
        app.log.error({ provider, upstreamUrl, err }, 'Upstream request failed');
        return reply.code(502).send({
          error: 'UpstreamError',
          message: `Failed to reach upstream for provider "${provider}".`,
        });
      }

      // 8. Stream response back
      reply.code(upstreamRes.status);

      for (const [k, v] of upstreamRes.headers.entries()) {
        if (SKIP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
        reply.header(k, v);
      }

      const responseBody = await upstreamRes.text();
      return reply.send(responseBody);
    },
  );
}
