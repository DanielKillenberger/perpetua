/**
 * Perpetua — Transparent OAuth Proxy
 * Entry point: wires up Fastify, registers all routes, starts refresh loop.
 */

import 'dotenv/config';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';

import { registerAuthRoutes } from './auth.js';
import { registerProxyRoutes } from './proxy.js';
import { startRefreshLoop } from './refresh.js';
import { getSQLiteStore } from './store/SQLiteStore.js';
import type { ITokenStore } from 'perpetua/store/types';
import { listProviders } from './providers.js';
import { requireApiKey } from './middleware.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main(): Promise<void> {
  // Initialize store
  const store: ITokenStore = getSQLiteStore();
  await store.init();

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  // Parse form bodies (needed for OAuth token exchange)
  await app.register(formbody);

  // Store app-wide decoration for dependency injection
  app.decorate('store', store);

  // ── Health / info routes ──────────────────────────────────────────────────────

  /**
   * GET /health
   * Health check endpoint (no auth required).
   * Used by load balancers, uptime monitoring, and Docker healthchecks.
   */
  app.get('/health', async () => {
    return { status: 'ok', version: '0.1.0' };
  });

  /**
   * GET /status
   * Expanded status endpoint showing all connected providers and their tokens.
   * Requires API key.
   */
  app.get('/status', { preHandler: requireApiKey }, async () => {
    const connections = await store.listConnections();
    
    return {
      status: 'ok',
      version: '0.1.0',
      connections: connections.map((conn) => ({
        provider: conn.provider,
        account: conn.account,
        status: conn.accessToken ? 'active' : 'inactive',
        scopes: conn.scopes ? conn.scopes.split(' ') : [],
        last_refreshed: new Date(conn.updatedAt * 1000).toISOString(),
        expires_at: conn.expiresAt ? new Date(conn.expiresAt * 1000).toISOString() : null,
        created_at: new Date(conn.createdAt * 1000).toISOString(),
      })),
    };
  });

  /**
   * GET /providers
   * List all registered OAuth providers.
   * Requires API key.
   */
  app.get('/providers', { preHandler: requireApiKey }, async () => {
    return { providers: listProviders() };
  });

  /**
   * GET /connections
   * List all stored connections (without refresh tokens).
   * Requires API key.
   */
  app.get('/connections', { preHandler: requireApiKey }, async () => {
    const connections = await store.listConnections();
    return { connections };
  });

  /**
   * DELETE /connections/:provider/:account
   * Revoke and delete a stored OAuth connection.
   * Requires API key.
   *
   * Example:
   *   curl -X DELETE http://localhost:3001/connections/oura/daniel \
   *     -H "Authorization: Bearer <api-key>"
   */
  app.delete<{ Params: { provider: string; account: string } }>(
    '/connections/:provider/:account',
    { preHandler: requireApiKey },
    async (request, reply) => {
      const { provider, account } = request.params;

      // Delete from store
      await store.deleteToken(provider, account);

      return reply.send({
        message: `Connection ${provider}/${account} revoked and deleted.`,
        provider,
        account,
      });
    },
  );

  // ── Auth routes ───────────────────────────────────────────────────────────────
  registerAuthRoutes(app, store);

  // ── Proxy routes ──────────────────────────────────────────────────────────────
  registerProxyRoutes(app, store);

  // ── 404 catch-all ─────────────────────────────────────────────────────────────
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'NotFound', message: 'Route not found' });
  });

  // ── Error handler ─────────────────────────────────────────────────────────────
  app.setErrorHandler((error, request, reply) => {
    app.log.error({
      route: request.routerPath,
      method: request.method,
      statusCode: error.statusCode,
      err: error,
    }, 'Unhandled route error');

    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      reply.code(statusCode).send({
        error: 'InternalError',
        message: 'An unexpected error occurred',
      });
      return;
    }

    reply.code(statusCode).send({
      error: error.name ?? 'RequestError',
      message: error.message ?? 'Request failed',
    });
  });

  // ── Start ─────────────────────────────────────────────────────────────────────
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Perpetua listening on ${HOST}:${PORT}`);

  // Start background token refresh
  startRefreshLoop(store);
}

main().catch((err) => {
  console.error('Fatal error starting Perpetua:', err);
  process.exit(1);
});
