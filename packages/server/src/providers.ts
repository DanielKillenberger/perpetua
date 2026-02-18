/**
 * Provider registry — loads providers.yml and resolves env var placeholders.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';

export interface ProviderConfig {
  display_name: string;
  base_url: string;
  auth_url: string;
  token_url: string;
  client_id: string;
  client_secret: string;
  scopes: string[];
  extra_params?: Record<string, string>;
  token_expiry_buffer_seconds?: number;
}

type ProvidersFile = {
  providers: Record<string, {
    display_name: string;
    base_url: string;
    auth_url: string;
    token_url: string;
    client_id: string;
    client_secret: string;
    scopes: string[];
    extra_params?: Record<string, string>;
    token_expiry_buffer_seconds?: number;
  }>;
};

let _registry: Map<string, ProviderConfig> | null = null;

/** Resolve ${ENV_VAR} placeholders in a string. */
function resolveEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    const val = process.env[name];
    if (!val) {
      throw new Error(`Missing required env var: ${name}`);
    }
    return val;
  });
}

function loadProviders(): Map<string, ProviderConfig> {
  const filePath = resolve(
    process.env.PROVIDERS_FILE ?? resolve(__dirname, '../providers.yml'),
  );

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    // Fallback: one level up (handles unexpected cwd scenarios)
    const fallback = resolve(__dirname, '../../providers.yml');
    raw = readFileSync(fallback, 'utf8');
  }

  const parsed = yaml.load(raw) as ProvidersFile;
  const registry = new Map<string, ProviderConfig>();

  for (const [slug, cfg] of Object.entries(parsed.providers)) {
    try {
      registry.set(slug, {
        display_name: cfg.display_name,
        base_url: cfg.base_url.replace(/\/$/, ''),
        auth_url: cfg.auth_url,
        token_url: cfg.token_url,
        client_id: resolveEnv(cfg.client_id),
        client_secret: resolveEnv(cfg.client_secret),
        scopes: cfg.scopes,
        extra_params: cfg.extra_params,
        token_expiry_buffer_seconds: cfg.token_expiry_buffer_seconds,
      });
    } catch (err) {
      // Skip providers with missing credentials — they won't be available
      // until the env vars are set. This allows the service to run with
      // only the providers that are actually configured.
      console.warn(`[providers] Skipping "${slug}": ${(err as Error).message}`);
    }
  }

  return registry;
}

export function getRegistry(): Map<string, ProviderConfig> {
  if (!_registry) {
    _registry = loadProviders();
  }
  return _registry;
}

export function getProvider(slug: string): ProviderConfig | undefined {
  return getRegistry().get(slug);
}

export function listProviders(): Array<{ slug: string; display_name: string; base_url: string }> {
  return Array.from(getRegistry().entries()).map(([slug, cfg]) => ({
    slug,
    display_name: cfg.display_name,
    base_url: cfg.base_url,
  }));
}
