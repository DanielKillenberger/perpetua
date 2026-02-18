/**
 * API key authentication middleware.
 * Checks Authorization: Bearer <key> against API_KEY env var.
 * Uses timing-safe comparison to prevent timing attacks.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual, createHash } from 'crypto';

function getApiKeyHash(): Buffer {
  const key = process.env.API_KEY;
  if (!key) throw new Error('API_KEY env var is required');
  return createHash('sha256').update(key).digest();
}

let _keyHash: Buffer | null = null;

function keyHash(): Buffer {
  if (!_keyHash) _keyHash = getApiKeyHash();
  return _keyHash;
}

export async function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    reply.code(401).send({
      error: 'Unauthorized',
      message: 'Authorization: Bearer <api_key> header required',
    });
    return;
  }

  const provided = authHeader.slice(7);
  const providedHash = createHash('sha256').update(provided).digest();

  try {
    const expected = keyHash();
    if (!timingSafeEqual(providedHash, expected)) {
      reply.code(401).send({ error: 'Unauthorized', message: 'Invalid API key' });
    }
  } catch {
    reply.code(500).send({ error: 'Internal', message: 'API_KEY not configured' });
  }
}
