/**
 * Tests for encryption/decryption (AES-256-GCM)
 */

import { encrypt, decrypt } from '../src/crypto';

describe('Crypto (AES-256-GCM)', () => {
  beforeEach(() => {
    // Generate a valid 64-char hex key (32 bytes)
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  test('should encrypt and decrypt plaintext', () => {
    const plaintext = 'my-secret-refresh-token';
    const encrypted = encrypt(plaintext);

    expect(encrypted).toContain(':');
    expect(encrypted).not.toEqual(plaintext);

    const decrypted = decrypt(encrypted);
    expect(decrypted).toEqual(plaintext);
  });

  test('should produce <24-char-hex-iv>:<hex-ciphertext> format', () => {
    const encrypted = encrypt('test-format');
    const [iv, data] = encrypted.split(':');

    // 12-byte IV = 24 hex chars
    expect(iv).toMatch(/^[0-9a-f]{24}$/);
    // ciphertext + 16-byte auth tag, all hex
    expect(data).toMatch(/^[0-9a-f]+$/);
    // data must be at least 32 hex chars (16-byte auth tag alone)
    expect(data!.length).toBeGreaterThanOrEqual(32);
  });

  test('should produce different ciphertexts for the same plaintext (IV randomness)', () => {
    const plaintext = 'same-token';
    const encrypted1 = encrypt(plaintext);
    const encrypted2 = encrypt(plaintext);

    expect(encrypted1).not.toEqual(encrypted2);
    expect(decrypt(encrypted1)).toEqual(plaintext);
    expect(decrypt(encrypted2)).toEqual(plaintext);
  });

  test('should handle long tokens', () => {
    const longToken = 'x'.repeat(1000);
    const encrypted = encrypt(longToken);
    const decrypted = decrypt(encrypted);

    expect(decrypted).toEqual(longToken);
  });

  test('should handle empty string', () => {
    const encrypted = encrypt('');
    expect(decrypt(encrypted)).toEqual('');
  });

  test('should handle special characters', () => {
    const special = 'token!@#$%^&*()_+-=[]{}|;:,.<>?';
    const encrypted = encrypt(special);
    expect(decrypt(encrypted)).toEqual(special);
  });

  test('should handle unicode and multi-byte characters', () => {
    const unicode = 'token-\u00e9\u00e8\u00ea-\u4f60\u597d-\ud83d\udd12';
    const encrypted = encrypt(unicode);
    expect(decrypt(encrypted)).toEqual(unicode);
  });

  test('should throw on malformed encrypted string', () => {
    expect(() => decrypt('invalid')).toThrow();
    expect(() => decrypt('no-colon')).toThrow();
  });

  test('should throw on tampered ciphertext', () => {
    const plaintext = 'secret';
    const encrypted = encrypt(plaintext);
    const [iv, data] = encrypted.split(':');

    // Flip a bit in the ciphertext
    const dataBuffer = Buffer.from(data!, 'hex');
    dataBuffer[0] ^= 0x01;
    const tampered = `${iv}:${dataBuffer.toString('hex')}`;

    expect(() => decrypt(tampered)).toThrow();
  });

  test('should throw on tampered IV', () => {
    const encrypted = encrypt('secret');
    const [iv, data] = encrypted.split(':');

    const ivBuffer = Buffer.from(iv!, 'hex');
    ivBuffer[0] ^= 0x01;
    const tampered = `${ivBuffer.toString('hex')}:${data}`;

    expect(() => decrypt(tampered)).toThrow();
  });

  test('should fail to decrypt with a different key', () => {
    const encrypted = encrypt('secret-data');

    // Switch to a different key
    process.env.ENCRYPTION_KEY = 'ff'.repeat(32);

    expect(() => decrypt(encrypted)).toThrow();
  });

  test('should throw if ENCRYPTION_KEY is missing', () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt('test')).toThrow(/ENCRYPTION_KEY/);
  });

  test('should throw if ENCRYPTION_KEY is wrong length', () => {
    process.env.ENCRYPTION_KEY = 'too-short';
    expect(() => encrypt('test')).toThrow(/64-char hex/);
  });

  test('should throw if ENCRYPTION_KEY is not hex', () => {
    process.env.ENCRYPTION_KEY = 'g'.repeat(64); // 'g' is not hex
    expect(() => encrypt('test')).toThrow();
  });
});
