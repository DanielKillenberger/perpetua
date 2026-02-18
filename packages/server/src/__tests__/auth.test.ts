/**
 * Tests for OAuth auth routes
 */

import { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { registerAuthRoutes } from '../auth';
import type { ITokenStore } from 'perpetua/store/types';
import * as store from '../store';
import * as providers from '../providers';

// Mock the store module
jest.mock('../store');

// Mock the providers module
jest.mock('../providers');

// Mock fetch globally
global.fetch = jest.fn();

describe('Auth Routes', () => {
  let app: FastifyInstance;
  let mockStore: ITokenStore;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.API_KEY = 'test-key';
    process.env.BASE_URL = 'http://localhost:3001';
    process.env.PORT = '3001';

    // Create mock store
    mockStore = {
      init: jest.fn(),
      storeToken: jest.fn(),
      getToken: jest.fn(),
      getDefaultToken: jest.fn(),
      updateAccessToken: jest.fn(),
      deleteToken: jest.fn(),
      listConnections: jest.fn(),
      getTokensNeedingRefresh: jest.fn(),
      saveOAuthState: jest.fn(),
      consumeOAuthState: jest.fn(),
      cleanOAuthStates: jest.fn(),
    } as unknown as ITokenStore;

    // Mock the getProvider function
    (providers.getProvider as jest.Mock).mockImplementation((slug: string) => {
      const mockProviders: Record<string, any> = {
        oura: {
          display_name: 'Oura Ring',
          base_url: 'https://api.ouraring.com',
          auth_url: 'https://cloud.ouraring.com/oauth/authorize',
          token_url: 'https://api.ouraring.com/oauth/token',
          client_id: 'test-oura-client-id',
          client_secret: 'test-oura-secret',
          scopes: ['personal', 'daily', 'sleep'],
        },
        gcal: {
          display_name: 'Google Calendar',
          base_url: 'https://www.googleapis.com/calendar/v3',
          auth_url: 'https://accounts.google.com/o/oauth2/v2/auth',
          token_url: 'https://oauth2.googleapis.com/token',
          client_id: 'test-gcal-client-id',
          client_secret: 'test-gcal-secret',
          scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
          extra_params: {
            access_type: 'offline',
            prompt: 'consent',
          },
        },
      };
      return mockProviders[slug];
    });

    app = Fastify();
    registerAuthRoutes(app, mockStore);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /auth/:provider/start', () => {
    test('should return auth_url and state for valid provider', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/oura/start',
        payload: { account: 'daniel' },
      });

      expect(response.statusCode).toEqual(200);
      const body = JSON.parse(response.body);

      expect(body.auth_url).toBeDefined();
      expect(body.auth_url).toContain('https://cloud.ouraring.com/oauth/authorize');
      expect(body.auth_url).toContain('client_id');
      expect(body.auth_url).toContain('redirect_uri');
      expect(body.auth_url).toContain('scope');
      expect(body.auth_url).toContain('state');
      expect(body.expires_in).toEqual(600);

      // Verify state was saved
      expect(mockStore.saveOAuthState).toHaveBeenCalled();
    });

    test('should use "default" account if not specified', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/oura/start',
        payload: {},
      });

      expect(response.statusCode).toEqual(200);
      const body = JSON.parse(response.body);
      expect(body.auth_url).toBeDefined();

      // saveOAuthState should be called with "default" account
      const call = (mockStore.saveOAuthState as jest.Mock).mock.calls[0];
      expect(call[2]).toEqual('default');
    });

    test('should include extra_params in auth URL', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/gcal/start',
        payload: { account: 'daniel' },
      });

      expect(response.statusCode).toEqual(200);
      const body = JSON.parse(response.body);

      // Google Calendar has access_type=offline and prompt=consent
      expect(body.auth_url).toContain('access_type=offline');
      expect(body.auth_url).toContain('prompt=consent');
    });

    test('should return 404 for unknown provider', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/unknown-provider/start',
        payload: {},
      });

      expect(response.statusCode).toEqual(404);
      const body = JSON.parse(response.body);
      expect(body.error).toEqual('UnknownProvider');
    });
  });

  describe('GET /auth/:provider/callback', () => {
    test('should handle missing code', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/auth/oura/callback?state=test-state',
      });

      expect(response.statusCode).toEqual(400);
      expect(response.body).toContain('Missing code or state');
    });

    test('should handle missing state', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/auth/oura/callback?code=test-code',
      });

      expect(response.statusCode).toEqual(400);
      expect(response.body).toContain('Missing code or state');
    });

    test('should handle invalid state', async () => {
      (mockStore.consumeOAuthState as jest.Mock).mockReturnValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/auth/oura/callback?code=test-code&state=invalid-state',
      });

      expect(response.statusCode).toEqual(400);
      expect(response.body).toContain('Invalid or expired state');
    });

    test('should exchange code for token on successful OAuth', async () => {
      (mockStore.consumeOAuthState as jest.Mock).mockReturnValue({
        provider: 'oura',
        account: 'daniel',
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
          scope: 'daily sleep',
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/auth/oura/callback?code=test-code&state=test-state',
      });

      expect(response.statusCode).toEqual(200);
      expect(response.body).toContain('✅ Connected');
      expect(response.body).toContain('oura');
      expect(response.body).toContain('daniel');

      // Verify token was stored
      expect(mockStore.storeToken).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'oura',
          account: 'daniel',
          refreshToken: 'new-refresh-token',
          accessToken: 'new-access-token',
        })
      );
    });

    test('should handle missing refresh_token in OAuth response', async () => {
      (mockStore.consumeOAuthState as jest.Mock).mockReturnValue({
        provider: 'oura',
        account: 'daniel',
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'access-only',
          // No refresh_token
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/auth/oura/callback?code=test-code&state=test-state',
      });

      expect(response.statusCode).toEqual(500);
      expect(response.body).toContain('No refresh token');
    });

    test('should handle token exchange failure', async () => {
      (mockStore.consumeOAuthState as jest.Mock).mockReturnValue({
        provider: 'oura',
        account: 'daniel',
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'Invalid authorization code',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/auth/oura/callback?code=bad-code&state=test-state',
      });

      expect(response.statusCode).toEqual(500);
      expect(response.body).toContain('Token exchange failed');
    });

    test('should handle network error during token exchange', async () => {
      (mockStore.consumeOAuthState as jest.Mock).mockReturnValue({
        provider: 'oura',
        account: 'daniel',
      });

      (global.fetch as jest.Mock).mockRejectedValue(new Error('Network timeout'));

      const response = await app.inject({
        method: 'GET',
        url: '/auth/oura/callback?code=test-code&state=test-state',
      });

      expect(response.statusCode).toEqual(500);
      expect(response.body).toContain('Token exchange failed');
    });

    test('should handle unknown provider', async () => {
      (mockStore.consumeOAuthState as jest.Mock).mockReturnValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/auth/unknown/callback?code=test-code&state=test-state',
      });

      // When state is invalid, we get 400 before checking provider
      expect(response.statusCode).toEqual(400);
      expect(response.body).toContain('Invalid or expired state');
    });

    test('should reject state from mismatched provider', async () => {
      let callCount = 0;
      (mockStore.consumeOAuthState as jest.Mock).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return {
            provider: 'gcal', // Different provider
            account: 'daniel',
          };
        }
        return null;
      });

      const response = await app.inject({
        method: 'GET',
        url: '/auth/oura/callback?code=test-code&state=test-state',
      });

      expect(response.statusCode).toEqual(400);
      expect(response.body).toContain('Invalid or expired state');
    });
  });
});
