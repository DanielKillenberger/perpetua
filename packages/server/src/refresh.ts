/**
 * Background token refresh loop.
 * Runs every 5 minutes; refreshes any token expiring within 10 minutes.
 */

import type { ITokenStore } from 'perpetua/store/types';
import { getProvider } from './providers.js';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const REFRESH_THRESHOLD_SEC = 10 * 60; // 10 minutes

async function refreshToken(
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
    throw new Error(`Token refresh failed with status ${res.status}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in?: number };
  const expiresAt = Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600);
  return { accessToken: data.access_token, expiresAt };
}

async function runRefreshCycle(store: ITokenStore): Promise<void> {
  // Find connections expiring soon or with no expiry info (refresh anyway)
  const tokens = await store.getTokensNeedingRefresh(REFRESH_THRESHOLD_SEC);

  if (tokens.length === 0) return;

  console.log(`[refresh] Checking ${tokens.length} connection(s) for refresh`);

  for (const token of tokens) {
    const providerCfg = getProvider(token.provider);
    if (!providerCfg) {
      console.warn(`[refresh] Unknown provider "${token.provider}" — skipping`);
      continue;
    }

    try {
      const { accessToken, expiresAt } = await refreshToken(
        providerCfg.token_url,
        providerCfg.client_id,
        providerCfg.client_secret,
        token.refreshToken,
      );
      await store.updateAccessToken(token.provider, token.account, accessToken, expiresAt);
      console.log(
        `[refresh] Refreshed ${token.provider}/${token.account} — expires at ${new Date(expiresAt * 1000).toISOString()}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[refresh] Failed to refresh ${token.provider}/${token.account}: ${message}`);
    }
  }
}

let _timer: ReturnType<typeof setInterval> | null = null;

export function startRefreshLoop(store: ITokenStore): void {
  if (_timer) return;

  // Run once at startup, then on interval
  void runRefreshCycle(store);
  _timer = setInterval(() => {
    void runRefreshCycle(store);
  }, REFRESH_INTERVAL_MS);

  // Don't block process exit
  if (_timer.unref) _timer.unref();

  console.log('[refresh] Background refresh loop started');
}

export function stopRefreshLoop(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
