/**
 * Tests for proxy route and token refresh logic
 */

import { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { registerProxyRoutes } from '../proxy';
import { requireApiKey } from '../middleware';
import type { ITokenStore } from 'perpetua/store/types';
import * as store from '../store';
import * as providers from '../providers';

// Mock the store module
jest.mock('../store');

// Mock the providers module
jest.mock('../providers');

// Mock fetch globally
global.fetch = jest.fn();

describe('Proxy Routes', () => {
  let app: FastifyInstance;
  const testApiKey = 'test-api-key';
  let mockStore: ITokenStore;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.API_KEY = testApiKey;

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

    // Mock the getProvider function to return test configs
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
    await app.register(formbody);
    
    // Register routes with preHandler for auth
    registerProxyRoutes(app, mockStore);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /proxy/:provider/*', () => {
    test('should reject request without API key', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/proxy/oura/v2/usercollection/daily_sleep',
      });

      expect(response.statusCode).toEqual(401);
      const body = JSON.parse(response.body);
      expect(body.error).toEqual('Unauthorized');
    });

    test('should reject request with invalid API key', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/proxy/oura/v2/usercollection/daily_sleep',
        headers: { authorization: 'Bearer wrong-key' },
      });

      expect(response.statusCode).toEqual(401);
      const body = JSON.parse(response.body);
      expect(body.error).toEqual('Unauthorized');
    });

    test('should return 404 for unknown provider', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/proxy/unknown-provider/some/path',
        headers: { authorization: `Bearer ${testApiKey}` },
      });

      expect(response.statusCode).toEqual(404);
      const body = JSON.parse(response.body);
      expect(body.error).toEqual('UnknownProvider');
    });

    test('should return 404 if no connection exists for provider', async () => {
      (mockStore.getToken as jest.Mock).mockReturnValue(null);
      (mockStore.getDefaultToken as jest.Mock).mockReturnValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/proxy/oura/v2/usercollection/daily_sleep',
        headers: { authorization: `Bearer ${testApiKey}` },
      });

      expect(response.statusCode).toEqual(404);
      const body = JSON.parse(response.body);
      expect(body.error).toEqual('NoConnection');
    });

    test('should forward request to upstream with fresh access token', async () => {
      const mockToken = {
        id: 'oura:daniel',
        provider: 'oura',
        account: 'daniel',
        refreshToken: 'refresh-token',
        accessToken: 'access-token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600, // Not expired
        scopes: 'daily sleep',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      (mockStore.getToken as jest.Mock).mockReturnValue(mockToken);

      (global.fetch as jest.Mock).mockResolvedValue({
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({ data: 'sleep data' }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/proxy/oura/v2/usercollection/daily_sleep',
        headers: { authorization: `Bearer ${testApiKey}` },
      });

      expect(response.statusCode).toEqual(200);
      expect(response.body).toContain('sleep data');

      // Verify fetch was called with correct auth header
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('https://api.ouraring.com/v2/usercollection/daily_sleep'),
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            authorization: 'Bearer access-token',
          }),
        })
      );
    });

    test('should refresh token if expired', async () => {
      const mockToken = {
        id: 'oura:daniel',
        provider: 'oura',
        account: 'daniel',
        refreshToken: 'refresh-token',
        accessToken: 'old-access-token',
        expiresAt: Math.floor(Date.now() / 1000) - 100, // Expired
        scopes: 'daily sleep',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      (mockStore.getToken as jest.Mock).mockImplementation((provider, account) => {
        if (provider === 'oura' && account === 'default') {
          return mockToken;
        }
        return null;
      });
      (mockStore.updateAccessToken as jest.Mock).mockImplementation(() => {
        mockToken.accessToken = 'new-access-token';
      });

      // Mock the token refresh endpoint
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'new-access-token',
            expires_in: 3600,
          }),
        })
        .mockResolvedValueOnce({
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          text: async () => JSON.stringify({ data: 'sleep data' }),
        });

      const response = await app.inject({
        method: 'GET',
        url: '/proxy/oura/v2/usercollection/daily_sleep',
        headers: { authorization: `Bearer ${testApiKey}` },
      });

      expect(response.statusCode).toEqual(200);

      // Verify token was refreshed (using the account resolved, which would be "default" if not specified)
      expect(mockStore.updateAccessToken).toHaveBeenCalledWith(
        'oura',
        'default', // No ?account= specified, so it uses default
        'new-access-token',
        expect.any(Number)
      );

      // Verify the proxied request used the new token
      const proxyCall = (global.fetch as jest.Mock).mock.calls[1];
      expect(proxyCall[1].headers.authorization).toEqual('Bearer new-access-token');
    });

    test('should refresh token if expiring within 5 minutes', async () => {
      const mockToken = {
        id: 'oura:daniel',
        provider: 'oura',
        account: 'daniel',
        refreshToken: 'refresh-token',
        accessToken: 'old-access-token',
        expiresAt: Math.floor(Date.now() / 1000) + 100, // Expires in ~100 seconds
        scopes: 'daily sleep',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      (mockStore.getToken as jest.Mock).mockReturnValue(mockToken);
      (mockStore.updateAccessToken as jest.Mock).mockImplementation(() => {
        mockToken.accessToken = 'new-access-token';
      });

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'new-access-token',
            expires_in: 3600,
          }),
        })
        .mockResolvedValueOnce({
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          text: async () => JSON.stringify({ data: 'sleep data' }),
        });

      const response = await app.inject({
        method: 'GET',
        url: '/proxy/oura/v2/usercollection/daily_sleep',
        headers: { authorization: `Bearer ${testApiKey}` },
      });

      expect(response.statusCode).toEqual(200);
      expect(mockStore.updateAccessToken).toHaveBeenCalled();
    });

    test('should return 401 if token refresh fails', async () => {
      const mockToken = {
        id: 'oura:daniel',
        provider: 'oura',
        account: 'daniel',
        refreshToken: 'refresh-token',
        accessToken: 'old-access-token',
        expiresAt: Math.floor(Date.now() / 1000) - 100, // Expired
        scopes: 'daily sleep',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      (mockStore.getToken as jest.Mock).mockReturnValue(mockToken);

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Invalid refresh token',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/proxy/oura/v2/usercollection/daily_sleep',
        headers: { authorization: `Bearer ${testApiKey}` },
      });

      expect(response.statusCode).toEqual(401);
      const body = JSON.parse(response.body);
      expect(body.error).toEqual('TokenRefreshFailed');
    });

    test('should use ?account= query parameter to select account', async () => {
      const mockToken = {
        id: 'oura:partner',
        provider: 'oura',
        account: 'partner',
        refreshToken: 'refresh-token',
        accessToken: 'access-token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scopes: 'daily sleep',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      (mockStore.getToken as jest.Mock).mockReturnValue(mockToken);

      (global.fetch as jest.Mock).mockResolvedValue({
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({ data: 'sleep data' }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/proxy/oura/v2/usercollection/daily_sleep?account=partner',
        headers: { authorization: `Bearer ${testApiKey}` },
      });

      expect(response.statusCode).toEqual(200);

      // Verify getToken was called with the right account
      expect(mockStore.getToken).toHaveBeenCalledWith('oura', 'partner');

      // Verify ?account= was stripped from upstream URL
      const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
      expect(fetchCall[0]).not.toContain('account=');
    });

    test('should preserve other query parameters', async () => {
      const mockToken = {
        id: 'oura:daniel',
        provider: 'oura',
        account: 'daniel',
        refreshToken: 'refresh-token',
        accessToken: 'access-token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scopes: 'daily sleep',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      (mockStore.getToken as jest.Mock).mockReturnValue(mockToken);

      (global.fetch as jest.Mock).mockResolvedValue({
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({ data: 'events' }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/proxy/gcal/calendars/primary/events?maxResults=10&singleEvents=true&account=default',
        headers: { authorization: `Bearer ${testApiKey}` },
      });

      expect(response.statusCode).toEqual(200);

      // Verify query params were preserved (except account)
      const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
      expect(fetchCall[0]).toContain('maxResults=10');
      expect(fetchCall[0]).toContain('singleEvents=true');
      expect(fetchCall[0]).not.toContain('account=');
    });

    test('should handle POST requests with body', async () => {
      const mockToken = {
        id: 'oura:daniel',
        provider: 'oura',
        account: 'daniel',
        refreshToken: 'refresh-token',
        accessToken: 'access-token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scopes: 'daily sleep',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      (mockStore.getToken as jest.Mock).mockReturnValue(mockToken);

      (global.fetch as jest.Mock).mockResolvedValue({
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({ success: true }),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/proxy/oura/some/endpoint',
        headers: { authorization: `Bearer ${testApiKey}` },
        payload: { some: 'data' },
      });

      expect(response.statusCode).toEqual(200);

      // Verify body was forwarded
      const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
      expect(fetchCall[1].method).toEqual('POST');
      expect(fetchCall[1].body).toContain('some');
    });

    test('should return 502 on upstream network error', async () => {
      const mockToken = {
        id: 'oura:daniel',
        provider: 'oura',
        account: 'daniel',
        refreshToken: 'refresh-token',
        accessToken: 'access-token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scopes: 'daily sleep',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      (mockStore.getToken as jest.Mock).mockReturnValue(mockToken);
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

      const response = await app.inject({
        method: 'GET',
        url: '/proxy/oura/v2/usercollection/daily_sleep',
        headers: { authorization: `Bearer ${testApiKey}` },
      });

      expect(response.statusCode).toEqual(502);
      const body = JSON.parse(response.body);
      expect(body.error).toEqual('UpstreamError');
    });
  });

  describe('Wildcard path matching', () => {
    test('should match any HTTP method', async () => {
      const mockToken = {
        id: 'oura:daniel',
        provider: 'oura',
        account: 'daniel',
        refreshToken: 'refresh-token',
        accessToken: 'access-token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scopes: 'daily sleep',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      (mockStore.getToken as jest.Mock).mockReturnValue(mockToken);

      (global.fetch as jest.Mock).mockResolvedValue({
        status: 204,
        headers: new Map(),
        text: async () => '',
      });

      for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
        const response = await app.inject({
          method: method as any,
          url: '/proxy/oura/v2/some/endpoint',
          headers: { authorization: `Bearer ${testApiKey}` },
        });

        expect(response.statusCode).toBeLessThan(400);
      }
    });
  });
});
