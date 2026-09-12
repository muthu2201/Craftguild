import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { err } from '../../domain/errors.js';

/**
 * Minimal, strict HS256 JWT. Written rather than pulled in so the algorithm is
 * pinned: `alg` from the token header is never trusted, which is the classic
 * JWT confusion bug.
 */

export interface TokenClaims {
  sub: string;
  role: 'reader' | 'creator' | 'admin';
  creatorId?: string;
  jti: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export interface JwtOptions {
  readonly secret: string;
  readonly ttlSeconds: number;
  readonly issuer?: string;
  readonly audience?: string;
}

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64url = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='), 'base64');

export class JwtSigner {
  private readonly issuer: string;
  private readonly audience: string;

  constructor(private readonly options: JwtOptions) {
    if (options.secret.length < 32) throw new Error('JWT secret must be at least 32 characters');
    this.issuer = options.issuer ?? 'craftguild';
    this.audience = options.audience ?? 'craftguild-api';
  }

  sign(payload: { sub: string; role: TokenClaims['role']; creatorId?: string }, nowMs = Date.now()): string {
    const iat = Math.floor(nowMs / 1000);
    const claims: TokenClaims = {
      sub: payload.sub,
      role: payload.role,
      ...(payload.creatorId ? { creatorId: payload.creatorId } : {}),
      jti: randomUUID(),
      iat,
      exp: iat + this.options.ttlSeconds,
      iss: this.issuer,
      aud: this.audience,
    };

    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify(claims));
    const signature = this.mac(`${header}.${body}`);
    return `${header}.${body}.${signature}`;
  }

  verify(token: string, nowMs = Date.now()): TokenClaims {
    const parts = token.split('.');
    if (parts.length !== 3) throw err.unauthorized('auth.malformed_token', 'token is malformed');
    const [header, body, signature] = parts as [string, string, string];

    const expected = this.mac(`${header}.${body}`);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw err.unauthorized('auth.bad_signature', 'token signature is invalid');
    }

    let decodedHeader: { alg?: string; typ?: string };
    let claims: TokenClaims;
    try {
      decodedHeader = JSON.parse(fromB64url(header).toString('utf8'));
      claims = JSON.parse(fromB64url(body).toString('utf8'));
    } catch {
      throw err.unauthorized('auth.bad_token_encoding', 'token is not valid JSON');
    }

    // Pin the algorithm: never take it from the token.
    if (decodedHeader.alg !== 'HS256') {
      throw err.unauthorized('auth.unexpected_alg', 'unsupported token algorithm');
    }

    const now = Math.floor(nowMs / 1000);
    if (typeof claims.exp !== 'number' || claims.exp <= now) {
      throw err.unauthorized('auth.token_expired', 'token has expired');
    }
    if (typeof claims.iat !== 'number' || claims.iat > now + 60) {
      throw err.unauthorized('auth.token_not_yet_valid', 'token is not yet valid');
    }
    if (claims.iss !== this.issuer) throw err.unauthorized('auth.bad_issuer', 'token issuer mismatch');
    if (claims.aud !== this.audience) throw err.unauthorized('auth.bad_audience', 'token audience mismatch');
    if (!claims.sub || !claims.role) throw err.unauthorized('auth.incomplete_claims', 'token is missing claims');

    return claims;
  }

  private mac(input: string): string {
    return b64url(createHmac('sha256', this.options.secret).update(input).digest());
  }
}
