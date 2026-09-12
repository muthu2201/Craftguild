import { randomUUID, createHash, randomBytes } from 'node:crypto';

/**
 * Prefixed identifiers. The UUIDv4 body keeps them globally unique; the prefix
 * makes logs, ledger references and support tickets unambiguous.
 */
export const ID_PREFIXES = {
  user: 'usr',
  creator: 'crt',
  work: 'wrk',
  chapter: 'chp',
  order: 'ord',
  payment: 'pay',
  redemption: 'rdm',
  refund: 'rfn',
  chargeback: 'cbk',
  entry: 'jrn',
  period: 'prd',
  statement: 'stm',
  payout: 'pot',
  vendor: 'vnd',
  outbox: 'obx',
  event: 'evt',
  reserve: 'rsv',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${randomUUID().replace(/-/g, '')}`;
}

export function isId(kind: IdKind, value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(`${ID_PREFIXES[kind]}_`) &&
    value.length === ID_PREFIXES[kind].length + 33
  );
}

/** Deterministic idempotency key derivation (blueprint Part 13). */
export function derivedIdempotencyKey(...parts: (string | number)[]): string {
  const h = createHash('sha256');
  for (const p of parts) {
    h.update(String(p));
    h.update(' ');
  }
  return h.digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
