import { newId } from '../domain/ids.js';
import { err } from '../domain/errors.js';
import type { Clock } from '../domain/clock.js';
import type { Database, UserRecord } from '../ports/repository.port.js';
import type { PasswordHasher } from '../adapters/crypto/passwords.js';
import type { JwtSigner } from '../adapters/crypto/jwt.js';
import { normalizeIndianMobile } from '../domain/tax/identifiers.js';

const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;

export interface AuthResult {
  token: string;
  expiresInSeconds: number;
  user: { id: string; email: string; displayName: string; role: UserRecord['role']; creatorId: string | null };
}

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly hasher: PasswordHasher,
    private readonly jwt: JwtSigner,
    private readonly clock: Clock,
    private readonly jwtTtlSeconds: number,
  ) {}

  async register(input: {
    email: string;
    password: string;
    displayName: string;
    phone?: string;
  }): Promise<AuthResult> {
    const email = normaliseEmail(input.email);
    if (!email) throw err.validation('auth.invalid_email', 'a valid email address is required');
    assertPasswordStrength(input.password);

    const phone = input.phone ? normalizeIndianMobile(input.phone) : null;
    if (input.phone && !phone) {
      throw err.validation('auth.invalid_phone', 'phone must be a valid 10-digit Indian mobile number');
    }

    const passwordHash = await this.hasher.hash(input.password);
    const id = newId('user');

    const user = await this.db.transaction(async (uow) => {
      const clash = await uow.query('SELECT 1 FROM users WHERE email_normalised = $1', [email]);
      if (clash.rowCount > 0) {
        throw err.conflict('auth.email_taken', 'an account already exists for this email address');
      }

      await uow.query(
        `INSERT INTO users (id, email, email_normalised, password_hash, display_name, phone, role)
         VALUES ($1, $2, $3, $4, $5, $6, 'reader')`,
        [id, input.email.trim(), email, passwordHash, input.displayName.trim(), phone],
      );
      // Every user gets a wallet on creation so redemption never has to create one.
      await uow.query('INSERT INTO credit_wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
      await uow.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, subject_type, subject_id, details)
         VALUES ($1, 'reader', 'user.registered', 'user', $1, '{}'::jsonb)`,
        [id],
      );
      return { id, email: input.email.trim(), displayName: input.displayName.trim(), role: 'reader' as const };
    });

    return this.issue({ ...user, creatorId: null });
  }

  async login(input: { email: string; password: string }): Promise<AuthResult> {
    const email = normaliseEmail(input.email);
    if (!email) throw err.unauthorized('auth.invalid_credentials', 'invalid email or password');

    const row = await this.db.transaction(
      async (uow) => {
        const res = await uow.query<{
          id: string;
          email: string;
          password_hash: string;
          display_name: string;
          role: UserRecord['role'];
          status: string;
          failed_logins: number;
          locked_until: Date | null;
          creator_id: string | null;
        }>(
          `SELECT u.id, u.email, u.password_hash, u.display_name, u.role, u.status,
                  u.failed_logins, u.locked_until, c.id AS creator_id
             FROM users u LEFT JOIN creators c ON c.user_id = u.id
            WHERE u.email_normalised = $1`,
          [email],
        );
        return res.rowCount > 0 ? res.rows[0]! : null;
      },
      { readOnly: true },
    );

    // Always spend the hashing cost so a missing account is not distinguishable by timing.
    const hashToCheck = row?.password_hash ?? DUMMY_HASH;
    const ok = await this.hasher.verify(input.password, hashToCheck);

    if (!row) throw err.unauthorized('auth.invalid_credentials', 'invalid email or password');
    if (row.status !== 'active') throw err.forbidden('auth.account_suspended', 'this account is suspended');

    const now = this.clock.now();
    if (row.locked_until && row.locked_until > now) {
      throw err.rateLimited('auth.locked_out', 'too many failed attempts; try again later', {
        retryAfterSeconds: Math.ceil((row.locked_until.getTime() - now.getTime()) / 1000),
      });
    }

    if (!ok) {
      await this.db.transaction(async (uow) => {
        await uow.query(
          `UPDATE users
              SET failed_logins = failed_logins + 1,
                  locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
            WHERE id = $1`,
          [row.id, MAX_FAILED_LOGINS, String(LOCKOUT_MINUTES)],
        );
      });
      throw err.unauthorized('auth.invalid_credentials', 'invalid email or password');
    }

    await this.db.transaction(async (uow) => {
      await uow.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [row.id]);
      if (this.hasher.needsRehash(row.password_hash)) {
        const upgraded = await this.hasher.hash(input.password);
        await uow.query('UPDATE users SET password_hash = $2 WHERE id = $1', [row.id, upgraded]);
      }
    });

    return this.issue({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      creatorId: row.creator_id,
    });
  }

  private issue(user: AuthResult['user']): AuthResult {
    const token = this.jwt.sign(
      {
        sub: user.id,
        role: user.role,
        ...(user.creatorId ? { creatorId: user.creatorId } : {}),
      },
      this.clock.now().getTime(),
    );
    return { token, expiresInSeconds: this.jwtTtlSeconds, user };
  }

  async promoteToCreator(userId: string, creatorId: string): Promise<void> {
    await this.db.transaction(async (uow) => {
      await uow.query(`UPDATE users SET role = 'creator' WHERE id = $1 AND role = 'reader'`, [userId]);
      await uow.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, subject_type, subject_id, details)
         VALUES ($1, 'creator', 'user.promoted_to_creator', 'creator', $2, '{}'::jsonb)`,
        [userId, creatorId],
      );
    });
  }
}

/** A precomputed scrypt hash of an unguessable value, used to equalise login timing. */
const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
  'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=';

export function normaliseEmail(raw: string): string | null {
  const email = String(raw ?? '').trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return null;
  return email;
}

export function assertPasswordStrength(password: string): void {
  if (typeof password !== 'string' || password.length < 10) {
    throw err.validation('auth.weak_password', 'password must be at least 10 characters');
  }
  if (password.length > 256) {
    throw err.validation('auth.password_too_long', 'password must be at most 256 characters');
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) {
    throw err.validation(
      'auth.weak_password',
      'password must mix at least three of: lowercase, uppercase, digits, symbols',
    );
  }
}
