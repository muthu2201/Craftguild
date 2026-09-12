import type { Paise } from '../domain/money/money.js';
import type { JournalEntry } from '../domain/ledger/journal.js';
import type { AccountName } from '../domain/ledger/accounts.js';
import type { EntityType } from '../domain/tax/policy.js';
import type { PeriodStatus } from '../domain/settlement/cycle.js';

/** A transactional unit of work. Every repository method takes one. */
export interface UnitOfWork {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  /** Serialise concurrent work on a business key inside this transaction. */
  advisoryLock(namespace: number, key: string): Promise<void>;
}

export interface Database {
  transaction<T>(fn: (uow: UnitOfWork) => Promise<T>, options?: { readonly isolation?: 'read committed' | 'repeatable read' | 'serializable'; readonly readOnly?: boolean }): Promise<T>;
  close(): Promise<void>;
  healthy(): Promise<boolean>;
}

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  phone: string | null;
  role: 'reader' | 'creator' | 'admin';
  status: 'active' | 'suspended';
  createdAt: Date;
}

export interface CreatorRecord {
  id: string;
  userId: string;
  legalName: string;
  penName: string;
  pan: string | null;
  panVerified: boolean;
  gstin: string | null;
  entityType: EntityType;
  stateCode: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankAccountHolder: string | null;
  upiVpa: string | null;
  vendorRef: string | null;
  providerVendorId: string | null;
  kycStatus: 'draft' | 'submitted' | 'pending' | 'in_review' | 'active' | 'blocked' | 'rejected';
  payoutsEnabled: boolean;
  firstPayoutHoldUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChapterRecord {
  id: string;
  workId: string;
  creatorId: string;
  sequence: number;
  title: string;
  priceCredits: number;
  status: 'draft' | 'published' | 'unpublished';
  publishedAt: Date | null;
}

export interface WorkRecord {
  id: string;
  creatorId: string;
  title: string;
  slug: string;
  synopsis: string;
  status: 'draft' | 'published' | 'archived';
  createdAt: Date;
}

export interface OrderRecord {
  id: string;
  userId: string;
  kind: 'credit_topup' | 'tip';
  sku: string | null;
  amountPaise: Paise;
  credits: number;
  status: 'created' | 'pending' | 'paid' | 'failed' | 'expired' | 'cancelled';
  providerOrderId: string | null;
  paymentSessionId: string | null;
  targetCreatorId: string | null;
  idempotencyKey: string;
  createdAt: Date;
  paidAt: Date | null;
}

export interface PaymentRecord {
  id: string;
  orderId: string;
  providerPaymentId: string;
  status: string;
  amountPaise: Paise;
  method: string;
  pgFeePaise: Paise;
  bankReference: string | null;
  capturedAt: Date | null;
  refundedPaise: Paise;
  chargebackPaise: Paise;
}

export interface RedemptionRecord {
  id: string;
  userId: string;
  chapterId: string | null;
  creatorId: string;
  periodId: string;
  kind: 'chapter' | 'tip';
  grossPaise: Paise;
  pgFeePaise: Paise;
  gstOnPgFeePaise: Paise;
  platformFeePaise: Paise;
  gstOnPlatformFeePaise: Paise;
  splitFeePaise: Paise;
  gstOnSplitFeePaise: Paise;
  creatorGrossPaise: Paise;
  reserveHeldPaise: Paise;
  reserveReleasedPaise: Paise;
  refundedPaise: Paise;
  status: 'active' | 'refunded' | 'partially_refunded' | 'charged_back';
  fundingOrderId: string | null;
  createdAt: Date;
}

export interface SettlementPeriodRecord {
  id: string;
  sequence: number;
  periodStart: Date;
  periodEnd: Date;
  graceEnd: Date;
  status: PeriodStatus;
  finalisedAt: Date | null;
}

export interface CreatorStatementRecord {
  id: string;
  periodId: string;
  creatorId: string;
  grossPaise: Paise;
  pgFeePaise: Paise;
  gstOnPgFeePaise: Paise;
  platformFeePaise: Paise;
  gstOnPlatformFeePaise: Paise;
  splitFeePaise: Paise;
  gstOnSplitFeePaise: Paise;
  tcsPaise: Paise;
  tdsPaise: Paise;
  reserveReleasedPaise: Paise;
  refundAdjustmentPaise: Paise;
  chargebackAdjustmentPaise: Paise;
  netPayablePaise: Paise;
  carriedForwardPaise: Paise;
  transactionCount: number;
  status: 'draft' | 'issued' | 'paid' | 'carried_forward';
  issuedAt: Date | null;
}

export interface PayoutRecord {
  id: string;
  creatorId: string;
  statementId: string;
  amountPaise: Paise;
  feePaise: Paise;
  status: 'queued' | 'instructed' | 'processing' | 'succeeded' | 'failed' | 'reversed';
  providerTransferId: string | null;
  utr: string | null;
  attempts: number;
  failureReason: string | null;
  createdAt: Date;
  settledAt: Date | null;
}

export interface AccountBalanceRow {
  accountCode: string;
  account: AccountName;
  creatorId: string | null;
  debitPaise: Paise;
  creditPaise: Paise;
  balancePaise: Paise;
}

export interface LedgerRepository {
  post(uow: UnitOfWork, entry: JournalEntry): Promise<{ entryId: string; created: boolean }>;
  trialBalance(uow: UnitOfWork, upTo?: Date): Promise<AccountBalanceRow[]>;
  accountBalance(uow: UnitOfWork, account: AccountName, creatorId?: string | null): Promise<Paise>;
  creatorPayable(uow: UnitOfWork, creatorId: string): Promise<Paise>;
}

export interface OutboxMessage {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
  attempts: number;
  availableAt: Date;
}
