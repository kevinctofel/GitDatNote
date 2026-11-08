/**
 * Credential encryption for session storage (task 3.1, design.md A-04).
 *
 * AES-256-GCM authenticated encryption from `node:crypto`. Every encryption
 * uses a fresh cryptographically random 12-byte IV; the IV, 16-byte
 * authentication tag, and ciphertext are stored in a versioned, unambiguous
 * format so stored values can be validated and rejected safely:
 *
 *   v1:<iv hex>:<tag hex>:<ciphertext hex>
 *
 * Key contract for `SESSION_ENCRYPTION_KEY`:
 * - exactly 64 hex characters (case-insensitive) — 256 bits of full entropy,
 * - used verbatim as the AES-256 key; never truncated, padded, hashed, or
 *   derived from a shorter passphrase,
 * - supplied through the environment only; never committed, never logged.
 *
 * A replacement key is never generated silently: a wrong or missing key
 * fails initialization (persisted sessions would otherwise become
 * undecryptable after restart).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Current on-disk ciphertext format version. */
export const CRYPTO_FORMAT_VERSION = 'v1';

/** GCM IV size in bytes. */
export const IV_BYTES = 12;
/** GCM authentication tag size in bytes. */
export const TAG_BYTES = 16;
/** Accepted `SESSION_ENCRYPTION_KEY` hex length (256 bits). */
export const ENCRYPTION_KEY_HEX_LENGTH = 64;
/** Accepted `SESSION_ENCRYPTION_KEY` byte length. */
export const ENCRYPTION_KEY_BYTE_LENGTH = 32;

/**
 * Parse `SESSION_ENCRYPTION_KEY` strictly.
 *
 * Returns the 32-byte key, or `null` when the value is missing, the wrong
 * length, or not pure hex. No truncation, padding, or derivation occurs.
 */
export function parseEncryptionKey(
  raw: string | undefined | null,
): Buffer | null {
  if (typeof raw !== 'string') return null;
  if (raw.length !== ENCRYPTION_KEY_HEX_LENGTH) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) return null;
  return Buffer.from(raw, 'hex');
}

/**
 * Encrypt a secret for storage. The returned string embeds a fresh random
 * IV and the GCM authentication tag, so two encryptions of the same value
 * never produce the same payload.
 */
export function sealSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    CRYPTO_FORMAT_VERSION,
    iv.toString('hex'),
    tag.toString('hex'),
    ciphertext.toString('hex'),
  ].join(':');
}

/**
 * Decrypt and authenticate a stored payload.
 *
 * Returns the plaintext, or `null` when the payload is malformed (wrong
 * version, missing segments, odd-length hex, wrong IV/tag length) or when
 * authentication fails (wrong key or tampered ciphertext/tag). Callers must
 * treat `null` as "secret unavailable" and must not surface raw crypto
 * error text to clients.
 */
export function openSecret(payload: string, key: Buffer): string | null {
  const parts = payload.split(':');
  if (parts.length !== 4) return null;
  const [version, ivHex, tagHex, ciphertextHex] = parts;
  if (version !== CRYPTO_FORMAT_VERSION) return null;

  let iv: Buffer;
  let tag: Buffer;
  let ciphertext: Buffer;
  try {
    iv = hexToBytes(ivHex, IV_BYTES);
    tag = hexToBytes(tagHex, TAG_BYTES);
    ciphertext = hexToBytes(ciphertextHex, undefined);
  } catch {
    return null;
  }

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Authentication failure (tampered ciphertext/tag or wrong key).
    return null;
  }
}

function hexToBytes(hex: string, expectedLength: number | undefined): Buffer {
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error('not hex');
  if (hex.length % 2 !== 0) throw new Error('odd length');
  const buf = Buffer.from(hex, 'hex');
  if (expectedLength !== undefined && buf.length !== expectedLength) {
    throw new Error('wrong length');
  }
  return buf;
}
