/**
 * SQLite token store using better-sqlite3.
 * DB path: ./data/perpetua.db (configurable via DB_PATH env).
 * Implements ITokenStore interface for secure token storage with encryption.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { encrypt, decrypt } from 'perpetua/crypto';
import { ITokenStore, StoredToken, Connection } from 'perpetua/store/types';

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  // Resolve DB_PATH lazily so tests can set process.env.DB_PATH in beforeAll
  // before the first database connection is opened.
  const dbPath = resolve(process.env.DB_PATH ?? './data/perpetua.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      account TEXT NOT NULL DEFAULT 'default',
      refresh_token_encrypted TEXT NOT NULL,
      access_token TEXT,
      expires_at INTEGER,
      scopes TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(provider, account)
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      account TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );
  `);
}

interface TokenRecord {
  id: string;
  provider: string;
  account: string;
  refreshToken: string; // decrypted
  accessToken: string | null;
  expiresAt: number | null; // unix seconds
  scopes: string | null;
  createdAt: number;
  updatedAt: number;
}

function rowToRecord(row: Record<string, unknown>): TokenRecord {
  return {
    id: row.id as string,
    provider: row.provider as string,
    account: row.account as string,
    refreshToken: decrypt(row.refresh_token_encrypted as string),
    accessToken: (row.access_token as string | null) ?? null,
    expiresAt: (row.expires_at as number | null) ?? null,
    scopes: (row.scopes as string | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function rowToConnection(row: Record<string, unknown>): Connection {
  return {
    id: row.id as string,
    provider: row.provider as string,
    account: row.account as string,
    accessToken: (row.access_token as string | null) ?? null,
    expiresAt: (row.expires_at as number | null) ?? null,
    scopes: (row.scopes as string | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

/**
 * SQLiteStore: ITokenStore implementation using better-sqlite3.
 */
export class SQLiteStore implements ITokenStore {
  async init(): Promise<void> {
    const db = getDb();
    migrate(db);
  }

  async storeToken(params: {
    provider: string;
    account: string;
    refreshToken: string;
    accessToken?: string;
    expiresAt?: number;
    scopes?: string;
  }): Promise<void> {
    const db = getDb();
    const id = `${params.provider}:${params.account}`;
    const encryptedRefresh = encrypt(params.refreshToken);

    db.prepare(`
      INSERT INTO connections (id, provider, account, refresh_token_encrypted, access_token, expires_at, scopes, updated_at)
      VALUES (@id, @provider, @account, @encryptedRefresh, @accessToken, @expiresAt, @scopes, unixepoch())
      ON CONFLICT(provider, account) DO UPDATE SET
        refresh_token_encrypted = @encryptedRefresh,
        access_token = @accessToken,
        expires_at = @expiresAt,
        scopes = @scopes,
        updated_at = unixepoch()
    `).run({
      id,
      provider: params.provider,
      account: params.account,
      encryptedRefresh,
      accessToken: params.accessToken ?? null,
      expiresAt: params.expiresAt ?? null,
      scopes: params.scopes ?? null,
    });
  }

  async getToken(provider: string, account: string): Promise<StoredToken | null> {
    const db = getDb();
    const row = db.prepare(`
      SELECT * FROM connections WHERE provider = ? AND account = ?
    `).get(provider, account) as Record<string, unknown> | undefined;

    if (!row) return null;

    const record = rowToRecord(row);
    return {
      provider: record.provider,
      account: record.account,
      refreshToken: record.refreshToken,
      accessToken: record.accessToken,
      expiresAt: record.expiresAt,
      scopes: record.scopes,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  async getDefaultToken(provider: string): Promise<StoredToken | null> {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM connections WHERE provider = ? ORDER BY account
    `).all(provider) as Record<string, unknown>[];

    if (rows.length === 0) return null;
    if (rows.length === 1) {
      const record = rowToRecord(rows[0]);
      return {
        provider: record.provider,
        account: record.account,
        refreshToken: record.refreshToken,
        accessToken: record.accessToken,
        expiresAt: record.expiresAt,
        scopes: record.scopes,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    }

    // Multiple connections — look for one explicitly named "default"
    const defaultRow = rows.find((r) => r.account === 'default');
    if (!defaultRow) return null;

    const record = rowToRecord(defaultRow);
    return {
      provider: record.provider,
      account: record.account,
      refreshToken: record.refreshToken,
      accessToken: record.accessToken,
      expiresAt: record.expiresAt,
      scopes: record.scopes,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  async updateAccessToken(
    provider: string,
    account: string,
    accessToken: string,
    expiresAt: number,
  ): Promise<void> {
    const db = getDb();
    db.prepare(`
      UPDATE connections SET access_token = ?, expires_at = ?, updated_at = unixepoch()
      WHERE provider = ? AND account = ?
    `).run(accessToken, expiresAt, provider, account);
  }

  async deleteToken(provider: string, account: string): Promise<void> {
    const db = getDb();
    db.prepare(`DELETE FROM connections WHERE provider = ? AND account = ?`).run(provider, account);
  }

  async listConnections(): Promise<Connection[]> {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, provider, account, access_token, expires_at, scopes, created_at, updated_at
      FROM connections ORDER BY provider, account
    `).all() as Record<string, unknown>[];

    return rows.map(rowToConnection);
  }

  async getTokensNeedingRefresh(thresholdSec: number): Promise<StoredToken[]> {
    const db = getDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const threshold = nowSec + thresholdSec;

    const rows = db
      .prepare(
        `SELECT * FROM connections
         WHERE expires_at IS NULL OR expires_at < ?`,
      )
      .all(threshold) as Record<string, unknown>[];

    return rows.map(rowToRecord).map((record) => ({
      provider: record.provider,
      account: record.account,
      refreshToken: record.refreshToken,
      accessToken: record.accessToken,
      expiresAt: record.expiresAt,
      scopes: record.scopes,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }));
  }

  async saveOAuthState(state: string, provider: string, account: string): Promise<void> {
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO oauth_states (state, provider, account) VALUES (?, ?, ?)
    `).run(state, provider, account);
  }

  async consumeOAuthState(state: string): Promise<{ provider: string; account: string } | null> {
    const db = getDb();
    const row = db.prepare(`SELECT provider, account FROM oauth_states WHERE state = ?`).get(state) as
      | { provider: string; account: string }
      | undefined;

    if (!row) return null;
    db.prepare(`DELETE FROM oauth_states WHERE state = ?`).run(state);
    return row;
  }

  async cleanOAuthStates(): Promise<void> {
    const db = getDb();
    db.prepare(`DELETE FROM oauth_states WHERE created_at < unixepoch() - 600`).run();
  }
}

// Singleton instance
let _instance: SQLiteStore | null = null;

export function getSQLiteStore(): SQLiteStore {
  if (!_instance) {
    _instance = new SQLiteStore();
  }
  return _instance;
}
