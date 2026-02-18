/**
 * ITokenStore: Abstract interface for token storage backends.
 * Implementations can use SQLite (OSS), PostgreSQL (hosted), or other backends.
 */

export interface StoredToken {
  provider: string;
  account: string;
  refreshToken: string; // encrypted
  accessToken: string | null;
  expiresAt: number | null; // unix seconds
  scopes: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Connection {
  id: string;
  provider: string;
  account: string;
  accessToken: string | null;
  expiresAt: number | null;
  scopes: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ITokenStore {
  /**
   * Initialize the store (e.g., create database tables, connect to DB).
   * Called once at startup.
   */
  init(): Promise<void>;

  /**
   * Store or update a token.
   */
  storeToken(params: {
    provider: string;
    account: string;
    refreshToken: string; // plaintext — will be encrypted by store
    accessToken?: string;
    expiresAt?: number;
    scopes?: string;
  }): Promise<void>;

  /**
   * Retrieve a token by provider and account.
   */
  getToken(provider: string, account: string): Promise<StoredToken | null>;

  /**
   * Retrieve a token without requiring explicit account name.
   * - 0 connections → null
   * - 1 connection  → return it (regardless of account name)
   * - 2+ connections → return the one named "default" if it exists, otherwise null
   */
  getDefaultToken(provider: string): Promise<StoredToken | null>;

  /**
   * Update access token and expiry without touching the refresh token.
   */
  updateAccessToken(
    provider: string,
    account: string,
    accessToken: string,
    expiresAt: number,
  ): Promise<void>;

  /**
   * Delete a token by provider and account.
   */
  deleteToken(provider: string, account: string): Promise<void>;

  /**
   * List all stored connections (without refresh tokens).
   */
  listConnections(): Promise<Connection[]>;

  /**
   * Get all tokens that need refreshing (expiring soon or with no expiry).
   * Used by background refresh loop.
   * Includes decrypted refresh tokens.
   */
  getTokensNeedingRefresh(thresholdSec: number): Promise<StoredToken[]>;

  /**
   * Save OAuth state for the authorization flow.
   */
  saveOAuthState(state: string, provider: string, account: string): Promise<void>;

  /**
   * Consume and delete OAuth state (returns null if not found or already consumed).
   */
  consumeOAuthState(state: string): Promise<{ provider: string; account: string } | null>;

  /**
   * Clean up expired OAuth states (older than 10 minutes).
   */
  cleanOAuthStates(): Promise<void>;
}
