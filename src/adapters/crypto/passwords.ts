import { scrypt, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing with scrypt (memory-hard, in the Node core crypto module, so
 * no native build step in the deployment image).
 *
 * Parameters: N=2^15, r=8, p=1 — roughly 32 MiB per hash, the OWASP-recommended
 * floor for scrypt. The encoded form carries its own parameters so they can be
 * raised later without invalidating existing hashes.
 */
const PARAMS = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 } as const;

export interface PasswordHasher {
  hash(plaintext: string): Promise<string>;
  verify(plaintext: string, encoded: string): Promise<boolean>;
  needsRehash(encoded: string): boolean;
}

export class ScryptPasswordHasher implements PasswordHasher {
  constructor(private readonly pepper: string = '') {}

  private season(plaintext: string): string {
    return this.pepper ? createHmac('sha256', this.pepper).update(plaintext).digest('base64') : plaintext;
  }

  async hash(plaintext: string): Promise<string> {
    if (typeof plaintext !== 'string' || plaintext.length < 10) {
      throw new Error('password must be at least 10 characters');
    }
    if (plaintext.length > 1024) throw new Error('password is too long');

    const salt = randomBytes(16);
    const derived = await scryptAsync(this.season(plaintext), salt, PARAMS.keylen, {
      N: PARAMS.N,
      r: PARAMS.r,
      p: PARAMS.p,
      maxmem: PARAMS.maxmem,
    });
    return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), derived.toString('base64')].join('$');
  }

  async verify(plaintext: string, encoded: string): Promise<boolean> {
    const parts = encoded.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts as [string, string, string, string, string, string];

    const N = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    if (N > 1 << 20 || r > 32 || p > 16) return false; // refuse absurd work factors from a tampered row

    let expected: Buffer;
    let salt: Buffer;
    try {
      expected = Buffer.from(hashB64, 'base64');
      salt = Buffer.from(saltB64, 'base64');
    } catch {
      return false;
    }

    const derived = await scryptAsync(this.season(plaintext), salt, expected.length, {
      N,
      r,
      p,
      maxmem: PARAMS.maxmem,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }

  needsRehash(encoded: string): boolean {
    const parts = encoded.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
    return Number(parts[1]) < PARAMS.N || Number(parts[2]) < PARAMS.r;
  }
}

/** Constant-time comparison of two short strings (API keys, tokens). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
