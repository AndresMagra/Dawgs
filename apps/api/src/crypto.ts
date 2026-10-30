/**
 * Password and token handling (from MeDu).
 *
 * Two primitives that look similar and must not be confused:
 *
 *   - PASSWORDS get scrypt. They are low-entropy and chosen by humans, so the
 *     only defence against an offline attack on a stolen dump is making each
 *     guess expensive.
 *
 *   - SESSION TOKENS get SHA-256. They are 256 bits from a CSPRNG, so there is
 *     nothing to guess and no work factor to buy. Using scrypt here would add
 *     ~100ms to every authenticated request and hand an attacker a cheap
 *     denial of service.
 *
 * Nothing here touches card numbers: Stripe holds cards, Dawgs keeps ids.
 *
 * Everything here uses node:crypto. A dependency in this position would be a
 * supply-chain foothold on every password in the system.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

// OWASP's floor for scrypt at the time of writing. N is the cost parameter;
// raising it later is safe because the parameters travel in the stored hash,
// so old passwords keep verifying with the parameters they were made with.
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

const TOKEN_BYTES = 32;

// ─── Passwords ──────────────────────────────────────────────────────────────

/**
 * `scrypt$N$r$p$salt$hash`, all base64url after the parameters.
 *
 * Self-describing on purpose: the work factor is a moving target, and a hash
 * that does not carry its own parameters cannot be upgraded without forcing
 * every user to reset.
 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(plain.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

/**
 * Constant-time verification.
 *
 * Returns false for a malformed stored hash rather than throwing: a corrupt
 * row must fail the login, not crash the endpoint for everyone.
 */
export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64url');
    expected = Buffer.from(parts[5]!, 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    // `maxmem` must be raised alongside N: node's default ceiling is 32MB and
    // scrypt needs roughly 128 * N * r bytes, so a future cost bump would
    // otherwise fail at verify time rather than at hash time.
    actual = scryptSync(plain.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 256 * N * r,
    });
  } catch {
    return false;
  }

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ─── Session tokens ─────────────────────────────────────────────────────────

/** 256 bits, base64url. The only time the raw token exists is in the response. */
export function randomToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// ─── Secrets at rest ────────────────────────────────────────────────────────

/**
 * Each daycare's Twilio auth token is stored AES-256-GCM encrypted under a
 * key derived from DAWGS_SECRET, which lives outside the database. A stolen
 * backup alone cannot send texts as anyone.
 */

const GCM_IV_BYTES = 12;

function keyFrom(secret: string): Buffer {
  return scryptSync(secret, 'dawgs-secrets-v1', 32);
}

export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function decryptSecret(blob: string, secret: string): string {
  const [v, iv, tag, body] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || !body) throw new Error('unreadable secret');
  const d = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
}
