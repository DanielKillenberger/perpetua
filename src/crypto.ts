/**
 * AES-256-GCM encryption helpers.
 * Key source: ENCRYPTION_KEY env var (64 hex chars = 32 bytes).
 * Stored format: "<iv_hex>:<ciphertext_hex>"
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit IV recommended for GCM
const TAG_BYTES = 16;

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt plaintext. Returns "<iv_hex>:<ciphertext+tag_hex>".
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a "<iv_hex>:<ciphertext+tag_hex>" string. Returns plaintext.
 */
export function decrypt(stored: string): string {
  const key = getKey();
  const [ivHex, dataHex] = stored.split(':');
  if (!ivHex || !dataHex) {
    throw new Error('Invalid encrypted value format');
  }

  const iv = Buffer.from(ivHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');

  // Last TAG_BYTES are the GCM auth tag
  const tag = data.subarray(data.length - TAG_BYTES);
  const ciphertext = data.subarray(0, data.length - TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
