/**
 * Tests for provider registry
 */

describe('Provider Registry', () => {
  beforeEach(() => {
    // Reset modules so _registry singleton is cleared between tests
    jest.resetModules();

    // Set mock env vars for all providers in providers.yml
    process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret';
    process.env.OURA_CLIENT_ID = 'test-oura-client-id';
    process.env.OURA_CLIENT_SECRET = 'test-oura-secret';
    process.env.STRAVA_CLIENT_ID = 'test-strava-client-id';
    process.env.STRAVA_CLIENT_SECRET = 'test-strava-secret';
    process.env.NOTION_CLIENT_ID = 'test-notion-client-id';
    process.env.NOTION_CLIENT_SECRET = 'test-notion-secret';
    process.env.SPOTIFY_CLIENT_ID = 'test-spotify-client-id';
    process.env.SPOTIFY_CLIENT_SECRET = 'test-spotify-secret';
  });

  afterEach(() => {
    jest.resetModules();
  });

  test('getProvider returns correct config for known slug', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getProvider } = require('../providers');
    const oura = getProvider('oura');

    expect(oura).toBeDefined();
    expect(oura.display_name).toEqual('Oura Ring');
    expect(oura.base_url).toEqual('https://api.ouraring.com');
    expect(oura.auth_url).toEqual('https://cloud.ouraring.com/oauth/authorize');
    expect(oura.token_url).toEqual('https://api.ouraring.com/oauth/token');
    expect(oura.client_id).toEqual('test-oura-client-id');
    expect(oura.client_secret).toEqual('test-oura-secret');
    expect(oura.scopes).toContain('daily');
  });

  test('getProvider returns undefined for unknown slug', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getProvider } = require('../providers');
    const result = getProvider('nonexistent-provider');
    expect(result).toBeUndefined();
  });

  test('getProvider returns gcal with extra_params', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getProvider } = require('../providers');
    const gcal = getProvider('gcal');

    expect(gcal).toBeDefined();
    expect(gcal.display_name).toEqual('Google Calendar');
    expect(gcal.extra_params).toEqual({
      access_type: 'offline',
      prompt: 'consent',
    });
    expect(gcal.token_expiry_buffer_seconds).toEqual(300);
  });

  test('listProviders returns all providers', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { listProviders } = require('../providers');
    const providers = listProviders();

    expect(providers).toBeInstanceOf(Array);
    expect(providers.length).toBeGreaterThanOrEqual(5);

    const slugs = providers.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain('gcal');
    expect(slugs).toContain('oura');
    expect(slugs).toContain('strava');
    expect(slugs).toContain('notion');
    expect(slugs).toContain('spotify');
  });

  test('listProviders entries have slug, display_name, base_url', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { listProviders } = require('../providers');
    const providers = listProviders();

    for (const p of providers) {
      expect(p).toHaveProperty('slug');
      expect(p).toHaveProperty('display_name');
      expect(p).toHaveProperty('base_url');
    }
  });

  test('getRegistry returns a Map', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getRegistry } = require('../providers');
    const registry = getRegistry();

    expect(registry).toBeInstanceOf(Map);
    expect(registry.size).toBeGreaterThanOrEqual(5);
  });

  test('getRegistry is cached (same instance on multiple calls)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getRegistry } = require('../providers');
    const first = getRegistry();
    const second = getRegistry();
    expect(first).toBe(second);
  });

  test('skips provider with missing env var (returns undefined, logs warning)', () => {
    delete process.env.OURA_CLIENT_ID;
    jest.resetModules();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getProvider } = require('../providers');
    // Provider is skipped gracefully — returns undefined rather than throwing
    expect(getProvider('oura')).toBeUndefined();
  });

  test('base_url has trailing slash stripped', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getProvider } = require('../providers');
    const oura = getProvider('oura');
    expect(oura.base_url).not.toMatch(/\/$/);
  });
});
