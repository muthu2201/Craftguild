import { newId } from '../domain/ids.js';
import { err } from '../domain/errors.js';
import { addDays, type Clock } from '../domain/clock.js';
import type { Database, CreatorRecord, UnitOfWork } from '../ports/repository.port.js';
import type { SettlementPort, VendorKycStatus } from '../ports/payment.port.js';
import type { CreatorTaxProfile, EntityType } from '../domain/tax/policy.js';
import {
  gstinMatchesPan,
  isValidBankAccount,
  isValidIfsc,
  isValidUpiVpa,
  normalizeIndianMobile,
  parseGstin,
  parsePan,
} from '../domain/tax/identifiers.js';
import type { AuthService } from './auth.service.js';
import type { Logger } from '../observability/logger.js';
import { LOCK_NS } from '../adapters/postgres/database.js';

/**
 * Creator onboarding.
 *
 * The creator is the supplier; the platform is the e-commerce operator. That
 * means the creator's payout instrument must be their own account (an RBI PA
 * rule), their PAN drives TDS treatment, and their GSTIN — optional, because an
 * individual below the registration threshold has none — drives TCS.
 */

export interface OnboardCreatorInput {
  userId: string;
  legalName: string;
  penName: string;
  pan: string;
  gstin?: string | null;
  stateCode?: string | null;
  bank?: { accountNumber: string; ifsc: string; accountHolder: string };
  upiVpa?: string;
  email: string;
  phone: string;
}

export class CreatorService {
  constructor(
    private readonly db: Database,
    private readonly settlementPort: SettlementPort,
    private readonly auth: AuthService,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly firstPayoutHoldDays: number,
  ) {}

  async onboard(input: OnboardCreatorInput): Promise<CreatorRecord> {
    const pan = parsePan(input.pan);
    if (!pan) throw err.validation('creator.invalid_pan', 'PAN is not in a valid format');

    if (input.gstin) {
      const gstin = parseGstin(input.gstin);
      if (!gstin) {
        throw err.validation('creator.invalid_gstin', 'GSTIN failed format or check-digit validation');
      }
      if (!gstinMatchesPan(input.gstin, input.pan)) {
        throw err.validation('creator.gstin_pan_mismatch', 'the GSTIN is not issued against this PAN');
      }
    }

    const hasBank = !!input.bank;
    const hasUpi = !!input.upiVpa;
    if (!hasBank && !hasUpi) {
      throw err.validation('creator.no_payout_instrument', 'provide a bank account or a UPI VPA');
    }
    if (input.bank) {
      if (!isValidBankAccount(input.bank.accountNumber)) {
        throw err.validation('creator.invalid_bank_account', 'bank account number is not valid');
      }
      if (!isValidIfsc(input.bank.ifsc)) {
        throw err.validation('creator.invalid_ifsc', 'IFSC is not valid');
      }
    }
    if (input.upiVpa && !isValidUpiVpa(input.upiVpa)) {
      throw err.validation('creator.invalid_vpa', 'UPI VPA is not valid');
    }

    const phone = normalizeIndianMobile(input.phone);
    if (!phone) throw err.validation('creator.invalid_phone', 'a valid 10-digit Indian mobile number is required');

    const entityType = pan.entityType as EntityType;
    const stateCode = input.gstin ? parseGstin(input.gstin)!.stateCode : (input.stateCode ?? null);
    const creatorId = newId('creator');
    const vendorRef = `cg_${creatorId.slice(4, 24)}`;

    // Persist first in `submitted`, then call the PA. If the PA call fails the
    // creator row survives and onboarding can be retried; we never hold an
    // external side effect inside a database transaction.
    const created = await this.db.transaction(async (uow) => {
      const user = await uow.query<{ id: string }>('SELECT id FROM users WHERE id = $1 FOR UPDATE', [input.userId]);
      if (user.rowCount === 0) throw err.notFound('creator.user_missing', 'user does not exist');

      const existing = await uow.query<{ id: string }>('SELECT id FROM creators WHERE user_id = $1', [input.userId]);
      if (existing.rowCount > 0) {
        throw err.conflict('creator.already_onboarded', 'this user already has a creator profile');
      }

      await uow.query(
        `INSERT INTO creators
           (id, user_id, legal_name, pen_name, pan, pan_verified, gstin, entity_type, state_code,
            bank_account_number, bank_ifsc, bank_account_holder, upi_vpa, vendor_ref, kyc_status,
            first_payout_hold_until)
         VALUES ($1,$2,$3,$4,$5,TRUE,$6,$7,$8,$9,$10,$11,$12,$13,'submitted',$14)`,
        [
          creatorId,
          input.userId,
          input.legalName.trim(),
          input.penName.trim(),
          pan.pan,
          input.gstin ? input.gstin.trim().toUpperCase() : null,
          entityType,
          stateCode,
          input.bank?.accountNumber ?? null,
          input.bank?.ifsc.toUpperCase() ?? null,
          input.bank?.accountHolder ?? null,
          input.upiVpa ?? null,
          vendorRef,
          addDays(this.clock.now(), this.firstPayoutHoldDays),
        ],
      );

      await uow.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, subject_type, subject_id, details)
         VALUES ($1, 'creator', 'creator.onboarding_submitted', 'creator', $2, $3::jsonb)`,
        [input.userId, creatorId, JSON.stringify({ hasGstin: !!input.gstin, entityType })],
      );

      return this.loadById(uow, creatorId);
    });

    await this.auth.promoteToCreator(input.userId, creatorId);

    // Register the creator as an Easy Split vendor so the PA can settle their
    // share directly to their own account.
    try {
      const vendor = await this.settlementPort.registerVendor({
        vendorRef,
        name: input.legalName.trim(),
        email: input.email,
        phone,
        pan: pan.pan,
        accountType: entityType === 'individual' || entityType === 'huf' ? 'individual' : 'company',
        ...(input.bank
          ? {
              bank: {
                accountNumber: input.bank.accountNumber,
                ifsc: input.bank.ifsc.toUpperCase(),
                accountHolder: input.bank.accountHolder,
              },
            }
          : {}),
        ...(input.upiVpa ? { upiVpa: input.upiVpa } : {}),
        gstin: input.gstin ?? null,
      });

      return await this.applyVendorStatus(creatorId, vendor.providerVendorId, vendor.status, null);
    } catch (e) {
      this.logger.error({ err: e, creatorId }, 'vendor registration with the payment aggregator failed');
      await this.db.transaction(async (uow) => {
        await uow.query(
          `UPDATE creators SET kyc_status = 'pending', kyc_failure_reason = $2, updated_at = now() WHERE id = $1`,
          [creatorId, truncate((e as Error).message, 500)],
        );
      });
      // Onboarding is not lost: the retry path re-registers the vendor.
      return created;
    }
  }

  /** Retry vendor registration for a creator stuck in `pending`. */
  async retryVendorRegistration(creatorId: string): Promise<CreatorRecord> {
    const creator = await this.db.transaction((uow) => this.loadById(uow, creatorId), { readOnly: true });
    if (creator.kycStatus === 'active') return creator;
    if (!creator.vendorRef) throw err.internal('creator.no_vendor_ref', 'creator has no vendor reference');

    const user = await this.db.transaction(
      async (uow) => {
        const res = await uow.query<{ email: string; phone: string | null }>(
          'SELECT email, phone FROM users WHERE id = $1',
          [creator.userId],
        );
        return res.rows[0]!;
      },
      { readOnly: true },
    );

    const existing = await this.settlementPort.getVendor(creator.vendorRef);
    const vendor =
      existing ??
      (await this.settlementPort.registerVendor({
        vendorRef: creator.vendorRef,
        name: creator.legalName,
        email: user.email,
        phone: user.phone ?? '',
        pan: creator.pan ?? '',
        accountType: creator.entityType === 'individual' || creator.entityType === 'huf' ? 'individual' : 'company',
        ...(creator.bankAccountNumber && creator.bankIfsc
          ? {
              bank: {
                accountNumber: creator.bankAccountNumber,
                ifsc: creator.bankIfsc,
                accountHolder: creator.bankAccountHolder ?? creator.legalName,
              },
            }
          : {}),
        ...(creator.upiVpa ? { upiVpa: creator.upiVpa } : {}),
        gstin: creator.gstin,
      }));

    return this.applyVendorStatus(creatorId, vendor.providerVendorId, vendor.status, null);
  }

  async applyVendorStatus(
    creatorId: string,
    providerVendorId: string,
    status: VendorKycStatus,
    failureReason: string | null,
  ): Promise<CreatorRecord> {
    return this.db.transaction(async (uow) => {
      const payoutsEnabled = status === 'active';
      await uow.query(
        `UPDATE creators
            SET provider_vendor_id = $2, kyc_status = $3, payouts_enabled = $4,
                kyc_failure_reason = $5, updated_at = now()
          WHERE id = $1`,
        [creatorId, providerVendorId, status, payoutsEnabled, failureReason],
      );
      await uow.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, subject_type, subject_id, details)
         VALUES (NULL, 'system', 'creator.kyc_status_changed', 'creator', $1, $2::jsonb)`,
        [creatorId, JSON.stringify({ status, providerVendorId })],
      );
      return this.loadById(uow, creatorId);
    });
  }

  /** Add or update a GSTIN as a creator approaches the registration threshold. */
  async updateGstin(creatorId: string, gstin: string | null): Promise<CreatorRecord> {
    return this.db.transaction(async (uow) => {
      await uow.advisoryLock(LOCK_NS.CREATOR, creatorId);
      const creator = await this.loadById(uow, creatorId);

      if (gstin) {
        const parsed = parseGstin(gstin);
        if (!parsed) throw err.validation('creator.invalid_gstin', 'GSTIN failed format or check-digit validation');
        if (!creator.pan || parsed.pan !== creator.pan) {
          throw err.validation('creator.gstin_pan_mismatch', 'the GSTIN is not issued against this PAN');
        }
        await uow.query(
          `UPDATE creators SET gstin = $2, state_code = $3, gstin_verified_at = now(), updated_at = now() WHERE id = $1`,
          [creatorId, parsed.gstin, parsed.stateCode],
        );
      } else {
        await uow.query(
          `UPDATE creators SET gstin = NULL, gstin_verified_at = NULL, updated_at = now() WHERE id = $1`,
          [creatorId],
        );
      }

      await uow.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, subject_type, subject_id, details)
         VALUES ($1, 'creator', 'creator.gstin_updated', 'creator', $1, $2::jsonb)`,
        [creatorId, JSON.stringify({ registered: !!gstin })],
      );
      return this.loadById(uow, creatorId);
    });
  }

  async loadById(uow: UnitOfWork, creatorId: string): Promise<CreatorRecord> {
    const res = await uow.query<CreatorRow>('SELECT * FROM creators WHERE id = $1', [creatorId]);
    if (res.rowCount === 0) throw err.notFound('creator.not_found', 'creator does not exist', { creatorId });
    return mapCreator(res.rows[0]!);
  }

  async byUserId(userId: string): Promise<CreatorRecord | null> {
    return this.db.transaction(
      async (uow) => {
        const res = await uow.query<CreatorRow>('SELECT * FROM creators WHERE user_id = $1', [userId]);
        return res.rowCount > 0 ? mapCreator(res.rows[0]!) : null;
      },
      { readOnly: true },
    );
  }

  async byVendorRef(uow: UnitOfWork, vendorRef: string): Promise<CreatorRecord | null> {
    const res = await uow.query<CreatorRow>('SELECT * FROM creators WHERE vendor_ref = $1', [vendorRef]);
    return res.rowCount > 0 ? mapCreator(res.rows[0]!) : null;
  }

  /** Creators within 80% of their own GST registration threshold. */
  async creatorsApproachingGstThreshold(thresholdPaise: number): Promise<{ creatorId: string; gross: number }[]> {
    return this.db.transaction(
      async (uow) => {
        const res = await uow.query<{ id: string; lifetime_gross_paise: number }>(
          `SELECT id, lifetime_gross_paise FROM creators
            WHERE gstin IS NULL AND lifetime_gross_paise >= $1
            ORDER BY lifetime_gross_paise DESC`,
          [Math.floor(thresholdPaise * 0.8)],
        );
        return res.rows.map((r) => ({ creatorId: r.id, gross: r.lifetime_gross_paise }));
      },
      { readOnly: true },
    );
  }
}

export function taxProfileOf(creator: CreatorRecord): CreatorTaxProfile {
  return {
    creatorId: creator.id,
    pan: creator.pan,
    panVerified: creator.panVerified,
    gstin: creator.gstin,
    entityType: creator.entityType,
    stateCode: creator.stateCode,
  };
}

interface CreatorRow {
  id: string;
  user_id: string;
  legal_name: string;
  pen_name: string;
  pan: string | null;
  pan_verified: boolean;
  gstin: string | null;
  entity_type: string;
  state_code: string | null;
  bank_account_number: string | null;
  bank_ifsc: string | null;
  bank_account_holder: string | null;
  upi_vpa: string | null;
  vendor_ref: string | null;
  provider_vendor_id: string | null;
  kyc_status: CreatorRecord['kycStatus'];
  payouts_enabled: boolean;
  first_payout_hold_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function mapCreator(r: CreatorRow): CreatorRecord {
  return {
    id: r.id,
    userId: r.user_id,
    legalName: r.legal_name,
    penName: r.pen_name,
    pan: r.pan,
    panVerified: r.pan_verified,
    gstin: r.gstin,
    entityType: r.entity_type as EntityType,
    stateCode: r.state_code,
    bankAccountNumber: r.bank_account_number,
    bankIfsc: r.bank_ifsc,
    bankAccountHolder: r.bank_account_holder,
    upiVpa: r.upi_vpa,
    vendorRef: r.vendor_ref,
    providerVendorId: r.provider_vendor_id,
    kycStatus: r.kyc_status,
    payoutsEnabled: r.payouts_enabled,
    firstPayoutHoldUntil: r.first_payout_hold_until,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
