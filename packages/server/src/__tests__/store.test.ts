/**
 * Tests for token store (SQLite with encryption)
 */

import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { SQLiteStore } from '../store/SQLiteStore';

// Use a temp DB for testing
const testDbPath = path.join(__dirname, '..', '__tests__', 'temp-test.db');

beforeAll(() => {
  // Set test encryption key and DB path
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  process.env.DB_PATH = testDbPath;
});

afterAll(() => {
  // Cleanup
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }
  if (fs.existsSync(testDbPath + '-wal')) {
    fs.unlinkSync(testDbPath + '-wal');
  }
  if (fs.existsSync(testDbPath + '-shm')) {
    fs.unlinkSync(testDbPath + '-shm');
  }
});

describe('Token Store', () => {
  let store: SQLiteStore;

  beforeEach(async () => {
    // Create a new store instance for each test
    store = new SQLiteStore();
    await store.init();

    // Clear tables before each test by querying the database directly
    const db = new Database(testDbPath);
    db.exec('DELETE FROM connections');
    db.exec('DELETE FROM oauth_states');
    db.close();
  });

  describe('storeToken & getToken', () => {
    test('should insert a new token', async () => {
      await store.storeToken({
        provider: 'oura',
        account: 'daniel',
        refreshToken: 'refresh-secret',
        accessToken: 'access-token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scopes: 'daily sleep',
      });

      const token = await store.getToken('oura', 'daniel');
      expect(token).toBeDefined();
      expect(token?.provider).toEqual('oura');
      expect(token?.account).toEqual('daniel');
      expect(token?.refreshToken).toEqual('refresh-secret');
      expect(token?.accessToken).toEqual('access-token');
    });

    test('should return null for non-existent token', async () => {
      const token = await store.getToken('oura', 'nonexistent');
      expect(token).toBeNull();
    });

    test('should update existing token', async () => {
      await store.storeToken({
        provider: 'oura',
        account: 'daniel',
        refreshToken: 'refresh-1',
        accessToken: 'access-1',
      });

      await store.storeToken({
        provider: 'oura',
        account: 'daniel',
        refreshToken: 'refresh-2',
        accessToken: 'access-2',
      });

      const token = await store.getToken('oura', 'daniel');
      expect(token?.refreshToken).toEqual('refresh-2');
      expect(token?.accessToken).toEqual('access-2');
    });

    test('should encrypt refresh tokens at rest', async () => {
      await store.storeToken({
        provider: 'oura',
        account: 'daniel',
        refreshToken: 'secret-refresh-token',
      });

      // Access the database directly for this test
      const db = new Database(testDbPath);
      const row = db.prepare('SELECT refresh_token_encrypted FROM connections WHERE provider = ? AND account = ?').get('oura', 'daniel') as any;
      db.close();
      
      expect(row.refresh_token_encrypted).not.toEqual('secret-refresh-token');
      expect(row.refresh_token_encrypted).toContain(':'); // IV:ciphertext format
    });
  });

  describe('getDefaultToken', () => {
    test('should return null if no tokens exist', async () => {
      const token = await store.getDefaultToken('oura');
      expect(token).toBeNull();
    });

    test('should return the only token if one exists', async () => {
      await store.storeToken({
        provider: 'oura',
        account: 'personal',
        refreshToken: 'refresh',
      });

      const token = await store.getDefaultToken('oura');
      expect(token?.account).toEqual('personal');
    });

    test('should return "default" account if multiple exist', async () => {
      await store.storeToken({
        provider: 'oura',
        account: 'personal',
        refreshToken: 'refresh-1',
      });

      await store.storeToken({
        provider: 'oura',
        account: 'default',
        refreshToken: 'refresh-2',
      });

      const token = await store.getDefaultToken('oura');
      expect(token?.account).toEqual('default');
    });

    test('should return null if multiple exist but none named "default"', async () => {
      await store.storeToken({
        provider: 'oura',
        account: 'account1',
        refreshToken: 'refresh-1',
      });

      await store.storeToken({
        provider: 'oura',
        account: 'account2',
        refreshToken: 'refresh-2',
      });

      const token = await store.getDefaultToken('oura');
      expect(token).toBeNull();
    });
  });

  describe('updateAccessToken', () => {
    test('should update access token and expiry', async () => {
      await store.storeToken({
        provider: 'oura',
        account: 'daniel',
        refreshToken: 'refresh',
        accessToken: 'old-access',
        expiresAt: 1000,
      });

      await store.updateAccessToken('oura', 'daniel', 'new-access', 2000);

      const token = await store.getToken('oura', 'daniel');
      expect(token?.accessToken).toEqual('new-access');
      expect(token?.expiresAt).toEqual(2000);
    });

    test('should not affect refresh token', async () => {
      const refreshToken = 'original-refresh';
      await store.storeToken({
        provider: 'oura',
        account: 'daniel',
        refreshToken,
      });

      await store.updateAccessToken('oura', 'daniel', 'new-access', 2000);

      const token = await store.getToken('oura', 'daniel');
      expect(token?.refreshToken).toEqual(refreshToken);
    });
  });

  describe('deleteToken', () => {
    test('should delete a token', async () => {
      await store.storeToken({
        provider: 'oura',
        account: 'daniel',
        refreshToken: 'refresh',
      });

      await store.deleteToken('oura', 'daniel');

      const token = await store.getToken('oura', 'daniel');
      expect(token).toBeNull();
    });

    test('should delete only specified account', async () => {
      await store.storeToken({
        provider: 'oura',
        account: 'daniel',
        refreshToken: 'refresh-1',
      });

      await store.storeToken({
        provider: 'oura',
        account: 'partner',
        refreshToken: 'refresh-2',
      });

      await store.deleteToken('oura', 'daniel');

      expect(await store.getToken('oura', 'daniel')).toBeNull();
      expect(await store.getToken('oura', 'partner')).not.toBeNull();
    });
  });

  describe('listConnections', () => {
    test('should return empty array initially', async () => {
      const connections = await store.listConnections();
      expect(connections).toEqual([]);
    });

    test('should list all connections (without refresh tokens)', async () => {
      await store.storeToken({
        provider: 'oura',
        account: 'daniel',
        refreshToken: 'secret-refresh',
        accessToken: 'access-token',
        scopes: 'daily sleep',
      });

      await store.storeToken({
        provider: 'gcal',
        account: 'default',
        refreshToken: 'another-secret',
      });

      const connections = await store.listConnections();
      expect(connections).toHaveLength(2);
      expect(connections[0]).toMatchObject({
        provider: 'gcal',
        account: 'default',
      });
      expect(connections[1]).toMatchObject({
        provider: 'oura',
        account: 'daniel',
      });

      // Refresh token should NOT be in the response
      expect(connections[0]).not.toHaveProperty('refreshToken');
    });
  });

  describe('OAuth state management', () => {
    test('should save and consume OAuth state', async () => {
      const state = 'random-state-abc123';
      await store.saveOAuthState(state, 'oura', 'daniel');

      const consumed = await store.consumeOAuthState(state);
      expect(consumed).toEqual({
        provider: 'oura',
        account: 'daniel',
      });

      // State should be deleted after consumption
      const secondRead = await store.consumeOAuthState(state);
      expect(secondRead).toBeNull();
    });

    test('should return null for non-existent state', async () => {
      const consumed = await store.consumeOAuthState('does-not-exist');
      expect(consumed).toBeNull();
    });

    test('should clean up expired OAuth states', async () => {
      const db = new Database(testDbPath);
      const state = 'old-state';

      // Insert a state with an old timestamp (11 minutes ago)
      db.prepare(`
        INSERT INTO oauth_states (state, provider, account, created_at)
        VALUES (?, ?, ?, ?)
      `).run(state, 'oura', 'daniel', Math.floor(Date.now() / 1000) - 660);
      db.close();

      // Should exist before cleanup
      let consumed = await store.consumeOAuthState(state);
      expect(consumed).not.toBeNull();

      // Re-insert old state
      const db2 = new Database(testDbPath);
      db2.prepare(`
        INSERT INTO oauth_states (state, provider, account, created_at)
        VALUES (?, ?, ?, ?)
      `).run(state, 'oura', 'daniel', Math.floor(Date.now() / 1000) - 660);
      db2.close();

      // Run cleanup
      await store.cleanOAuthStates();

      // Old state should be deleted
      consumed = await store.consumeOAuthState(state);
      expect(consumed).toBeNull();
    });
  });

  describe('getTokensNeedingRefresh', () => {
    test('should return tokens expiring within threshold', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      
      // Token expiring soon (within 10 minutes)
      await store.storeToken({
        provider: 'oura',
        account: 'daniel',
        refreshToken: 'refresh-1',
        accessToken: 'access-1',
        expiresAt: nowSec + 300, // expires in 5 minutes
      });

      // Token expiring far in future
      await store.storeToken({
        provider: 'gcal',
        account: 'default',
        refreshToken: 'refresh-2',
        accessToken: 'access-2',
        expiresAt: nowSec + 3600, // expires in 1 hour
      });

      const tokensNeedingRefresh = await store.getTokensNeedingRefresh(600); // 10 minutes threshold
      expect(tokensNeedingRefresh).toHaveLength(1);
      expect(tokensNeedingRefresh[0].provider).toEqual('oura');
      expect(tokensNeedingRefresh[0].refreshToken).toEqual('refresh-1');
    });

    test('should include tokens with no expiry', async () => {
      await store.storeToken({
        provider: 'oura',
        account: 'daniel',
        refreshToken: 'refresh',
        // no expiresAt
      });

      const tokensNeedingRefresh = await store.getTokensNeedingRefresh(600);
      expect(tokensNeedingRefresh).toHaveLength(1);
      expect(tokensNeedingRefresh[0].provider).toEqual('oura');
    });
  });
});
