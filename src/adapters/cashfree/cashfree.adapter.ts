import { createHmac, timingSafeEqual } from 'node:crypto';
import { PaHttpClient } from './http-client.js';
import { err } from '../../domain/errors.js';
import { paiseToRupeeString, rupeesToPaise, type Paise } from '../../domain/money/money.js';
import type { Logger } from '../../observability/logger.js';
import type {
  CreateOrderInput,
  CreateRefundInput,
  OrderRef,
  PaymentPort,
  PaymentResult,
  PaymentStatus,
  RefundRef,
  RefundStatus,
  SettlementPort,
  TransferInput,
  TransferRef,
  TransferStatus,
  VendorBalance,
  VendorKycStatus,
  VendorRef,
  VendorRegistration,
  WebhookEnvelope,
} from '../../ports/payment.port.js';

/**
 * Cashfree Payments adapter: PG Orders + Easy Split (marketplace settlements).
 *
 * Wire contract notes that matter:
 *  - Cashfree speaks decimal RUPEES on the wire; this process speaks integer
 *    paise. Every crossing of that boundary happens in this file.
 *  - Auth is `x-client-id` / `x-client-secret` with a pinned `x-api-version`.
 *  - Webhooks are signed as base64(HMAC-SHA256(timestamp + rawBody, secret))
 *    in `x-webhook-signature`, with the timestamp in `x-webhook-timestamp`.
 *
 * Endpoint paths are declared in one table because Cashfree versions its API
 * surface per merchant contract; ops can pin exact paths without a code change.
 */

export interface CashfreeConfig {
  readonly baseUrl: string;
  readonly appId: string;
  readonly secretKey: string;
  readonly apiVersion: string;
  readonly webhookSecret: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly notifyUrl?: string;
  readonly returnUrl?: string;
  /** Maximum accepted age of a webhook delivery, guarding against replay. */
  readonly webhookToleranceSeconds?: number;
  readonly paths?: Partial<typeof DEFAULT_PATHS>;
}

export const DEFAULT_PATHS = {
  createOrder: '/pg/orders',
  getOrder: (orderId: string) => `/pg/orders/${encodeURIComponent(orderId)}`,
  orderPayments: (orderId: string) => `/pg/orders/${encodeURIComponent(orderId)}/payments`,
  createRefund: (orderId: string) => `/pg/orders/${encodeURIComponent(orderId)}/refunds`,
  getRefund: (orderId: string, refundId: string) =>
    `/pg/orders/${encodeURIComponent(orderId)}/refunds/${encodeURIComponent(refundId)}`,
  createVendor: '/pg/easy-split/vendors',
  getVendor: (vendorId: string) => `/pg/easy-split/vendors/${encodeURIComponent(vendorId)}`,
  updateVendor: (vendorId: string) => `/pg/easy-split/vendors/${encodeURIComponent(vendorId)}`,
  vendorBalance: (vendorId: string) => `/pg/easy-split/vendors/${encodeURIComponent(vendorId)}/balances`,
  vendorSettlement: (vendorId: string) => `/pg/easy-split/vendors/${encodeURIComponent(vendorId)}/settlements`,
  getVendorSettlement: (vendorId: string, settlementId: string) =>
    `/pg/easy-split/vendors/${encodeURIComponent(vendorId)}/settlements/${encodeURIComponent(settlementId)}`,
};

const ORDER_STATUS_MAP: Record<string, PaymentStatus> = {
  ACTIVE: 'created',
  PAID: 'success',
  EXPIRED: 'cancelled',
  TERMINATED: 'cancelled',
  TERMINATION_REQUESTED: 'pending',
};

const PAYMENT_STATUS_MAP: Record<string, PaymentStatus> = {
  SUCCESS: 'success',
  NOT_ATTEMPTED: 'created',
  PENDING: 'pending',
  FAILED: 'failed',
  USER_DROPPED: 'user_dropped',
  CANCELLED: 'cancelled',
  VOID: 'cancelled',
};

const REFUND_STATUS_MAP: Record<string, RefundStatus> = {
  SUCCESS: 'success',
  PENDING: 'pending',
  ONHOLD: 'pending',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
};

const VENDOR_STATUS_MAP: Record<string, VendorKycStatus> = {
  ACTIVE: 'active',
  IN_BENE_CREATION: 'pending',
  PENDING: 'pending',
  IN_REVIEW: 'in_review',
  BLOCKED: 'blocked',
  DELETED: 'blocked',
  REJECTED: 'rejected',
};

const TRANSFER_STATUS_MAP: Record<string, TransferStatus> = {
  SUCCESS: 'success',
  PENDING: 'pending',
  PROCESSING: 'processing',
  INITIATED: 'processing',
  FAILED: 'failed',
  REVERSED: 'reversed',
  REJECTED: 'failed',
};

/** Cashfree sends rupees as a JSON number or a decimal string. */
function toPaise(value: unknown, field: string): Paise {
  if (value === null || value === undefined) {
    throw err.upstream('pa.missing_amount', `payment aggregator omitted ${field}`);
  }
  const n = typeof value === 'string' ? Number(value) : (value as number);
  if (!Number.isFinite(n)) {
    throw err.upstream('pa.bad_amount', `payment aggregator sent a non-numeric ${field}: ${String(value)}`);
  }
  return rupeesToPaise(n);
}

function toRupees(paise: Paise): number {
  return Number(paiseToRupeeString(paise));
}

function parseDate(value: unknown): Date | null {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export class CashfreeAdapter implements PaymentPort, SettlementPort {
  private readonly http: PaHttpClient;
  private readonly paths: typeof DEFAULT_PATHS;

  constructor(
    private readonly config: CashfreeConfig,
    private readonly logger: Logger,
  ) {
    this.paths = { ...DEFAULT_PATHS, ...config.paths };
    this.http = new PaHttpClient({
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      logger: logger.child({ component: 'cashfree' }),
      defaultHeaders: {
        'x-client-id': config.appId,
        'x-client-secret': config.secretKey,
        'x-api-version': config.apiVersion,
      },
    });
  }

  get metrics() {
    return { ...this.http.metrics, circuitState: this.http.circuitState };
  }

  async close(): Promise<void> {
    await this.http.close();
  }

  // -------------------------------------------------------------------------
  // PaymentPort
  // -------------------------------------------------------------------------

  async createOrder(input: CreateOrderInput): Promise<OrderRef> {
    const body: Record<string, unknown> = {
      order_id: input.orderId,
      order_amount: toRupees(input.amount),
      order_currency: input.currency,
      customer_details: {
        customer_id: input.customer.customerId,
        customer_email: input.customer.email,
        customer_phone: input.customer.phone,
        ...(input.customer.name ? { customer_name: input.customer.name } : {}),
      },
      order_meta: {
        return_url: input.returnUrl ?? this.config.returnUrl,
        notify_url: input.notifyUrl ?? this.config.notifyUrl,
      },
      ...(input.note ? { order_note: input.note } : {}),
      ...(input.expiresAt ? { order_expiry_time: input.expiresAt.toISOString() } : {}),
    };

    if (input.splits?.length) {
      body['order_splits'] = input.splits.map((s) => ({
        vendor_id: s.vendorRef,
        amount: toRupees(s.amount),
        ...(s.reserveAmount
          ? {
              tags: { reserve: String(s.reserveAmount) },
            }
          : {}),
      }));
    }

    const res = await this.http.send<CfOrder>({
      method: 'POST',
      path: this.paths.createOrder,
      body,
      idempotencyKey: input.idempotencyKey,
    });

    return this.mapOrder(res.body, input.orderId);
  }

  async getOrder(orderId: string): Promise<OrderRef> {
    const res = await this.http.send<CfOrder>({ method: 'GET', path: this.paths.getOrder(orderId) });
    return this.mapOrder(res.body, orderId);
  }

  private mapOrder(o: CfOrder, fallbackOrderId: string): OrderRef {
    if (!o?.payment_session_id && !o?.cf_order_id) {
      throw err.upstream('pa.malformed_order', 'payment aggregator returned an order without identifiers', {
        body: o as unknown,
      });
    }
    return {
      orderId: o.order_id ?? fallbackOrderId,
      providerOrderId: String(o.cf_order_id ?? ''),
      paymentSessionId: o.payment_session_id ?? '',
      status: ORDER_STATUS_MAP[String(o.order_status)] ?? 'pending',
      amount: toPaise(o.order_amount, 'order_amount'),
      expiresAt: parseDate(o.order_expiry_time),
    };
  }

  async getPaymentStatus(orderId: string): Promise<PaymentResult | null> {
    const res = await this.http.send<CfPayment[]>({
      method: 'GET',
      path: this.paths.orderPayments(orderId),
    });
    const payments = Array.isArray(res.body) ? res.body : [];
    if (payments.length === 0) return null;

    // Prefer a successful capture; otherwise report the most recent attempt.
    const success = payments.find((p) => String(p.payment_status) === 'SUCCESS');
    const chosen =
      success ??
      [...payments].sort(
        (a, b) => (parseDate(b.payment_time)?.getTime() ?? 0) - (parseDate(a.payment_time)?.getTime() ?? 0),
      )[0]!;

    return this.mapPayment(chosen, orderId);
  }

  private mapPayment(p: CfPayment, orderId: string): PaymentResult {
    return {
      providerPaymentId: String(p.cf_payment_id ?? ''),
      orderId: p.order_id ?? orderId,
      status: PAYMENT_STATUS_MAP[String(p.payment_status)] ?? 'pending',
      amount: toPaise(p.payment_amount, 'payment_amount'),
      method: describeMethod(p.payment_group, p.payment_method),
      capturedAt: parseDate(p.payment_completion_time ?? p.payment_time),
      bankReference: p.bank_reference ? String(p.bank_reference) : null,
      failureReason: p.payment_message ? String(p.payment_message) : null,
    };
  }

  async createRefund(input: CreateRefundInput): Promise<RefundRef> {
    const body: Record<string, unknown> = {
      refund_amount: toRupees(input.amount),
      refund_id: input.refundId,
      refund_note: input.note.slice(0, 100),
      refund_speed: 'STANDARD',
    };
    if (input.splitRefunds?.length) {
      body['refund_splits'] = input.splitRefunds.map((s) => ({
        vendor_id: s.vendorRef,
        amount: toRupees(s.amount),
      }));
    }

    const res = await this.http.send<CfRefund>({
      method: 'POST',
      path: this.paths.createRefund(input.orderId),
      body,
      idempotencyKey: input.idempotencyKey,
    });
    return this.mapRefund(res.body, input.refundId, input.amount);
  }

  async getRefund(orderId: string, refundId: string): Promise<RefundRef | null> {
    try {
      const res = await this.http.send<CfRefund>({
        method: 'GET',
        path: this.paths.getRefund(orderId, refundId),
      });
      return this.mapRefund(res.body, refundId, 0);
    } catch (e) {
      if ((e as { code?: string }).code === 'pa.http_404') return null;
      throw e;
    }
  }

  private mapRefund(r: CfRefund, fallbackId: string, fallbackAmount: Paise): RefundRef {
    return {
      refundId: r.refund_id ?? fallbackId,
      providerRefundId: String(r.cf_refund_id ?? ''),
      status: REFUND_STATUS_MAP[String(r.refund_status)] ?? 'pending',
      amount: r.refund_amount === undefined ? fallbackAmount : toPaise(r.refund_amount, 'refund_amount'),
      processedAt: parseDate(r.processed_at),
    };
  }

  /**
   * Verify a webhook delivery.
   *
   * Signature = base64(HMAC-SHA256(timestamp + rawBody, clientSecret)).
   * Comparison is constant-time, and a delivery older than the tolerance window
   * is rejected so a captured request cannot be replayed.
   */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): WebhookEnvelope {
    const signature = headerValue(headers, 'x-webhook-signature');
    const timestamp = headerValue(headers, 'x-webhook-timestamp');

    if (!signature || !timestamp) {
      throw err.unauthorized('webhook.missing_signature', 'webhook signature headers are missing');
    }

    const toleranceSeconds = this.config.webhookToleranceSeconds ?? 300;
    const tsSeconds = Number(timestamp);
    if (!Number.isFinite(tsSeconds)) {
      throw err.unauthorized('webhook.bad_timestamp', 'webhook timestamp is not numeric');
    }
    const ageSeconds = Math.abs(Date.now() / 1000 - tsSeconds);
    if (ageSeconds > toleranceSeconds) {
      throw err.unauthorized('webhook.stale', `webhook delivery is ${Math.round(ageSeconds)}s old`);
    }

    const expected = createHmac('sha256', this.config.webhookSecret)
      .update(timestamp + rawBody)
      .digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(signature, 'base64');
    } catch {
      throw err.unauthorized('webhook.bad_signature_encoding', 'webhook signature is not valid base64');
    }
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw err.unauthorized('webhook.signature_mismatch', 'webhook signature does not match');
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw err.validation('webhook.bad_json', 'webhook body is not valid JSON');
    }

    const type = String(parsed['type'] ?? 'UNKNOWN');
    const occurredAt = parseDate(parsed['event_time']) ?? new Date(tsSeconds * 1000);

    return {
      eventId: deriveEventId(type, parsed, timestamp),
      type,
      occurredAt,
      payload: parsed,
      raw: rawBody,
    };
  }

  // -------------------------------------------------------------------------
  // SettlementPort (Easy Split)
  // -------------------------------------------------------------------------

  async registerVendor(input: VendorRegistration): Promise<VendorRef> {
    const body: Record<string, unknown> = {
      vendor_id: input.vendorRef,
      status: 'ACTIVE',
      name: input.name,
      email: input.email,
      phone: input.phone,
      verify_account: true,
      dashboard_access: false,
      schedule_option: input.scheduleSettlement === false ? 8 : 1,
      kyc_details: {
        account_type: accountTypeFor(input.accountType),
        business_type: 'Digital Content',
        pan: input.pan,
        ...(input.gstin ? { gst: input.gstin } : {}),
      },
    };

    if (input.bank) {
      body['bank'] = {
        account_number: input.bank.accountNumber,
        account_holder: input.bank.accountHolder,
        ifsc: input.bank.ifsc,
      };
    }
    if (input.upiVpa) {
      body['upi'] = { vpa: input.upiVpa, account_holder: input.name };
    }
    if (!input.bank && !input.upiVpa) {
      throw err.validation('vendor.no_payout_instrument', 'a vendor needs a bank account or a UPI VPA');
    }

    const res = await this.http.send<CfVendor>({
      method: 'POST',
      path: this.paths.createVendor,
      body,
      idempotencyKey: `vendor:${input.vendorRef}`,
    });
    return this.mapVendor(res.body, input.vendorRef);
  }

  async getVendor(vendorRef: string): Promise<VendorRef | null> {
    try {
      const res = await this.http.send<CfVendor>({ method: 'GET', path: this.paths.getVendor(vendorRef) });
      return this.mapVendor(res.body, vendorRef);
    } catch (e) {
      if ((e as { code?: string }).code === 'pa.http_404') return null;
      throw e;
    }
  }

  async updateVendor(vendorRef: string, patch: Partial<VendorRegistration>): Promise<VendorRef> {
    const body: Record<string, unknown> = {};
    if (patch.name) body['name'] = patch.name;
    if (patch.email) body['email'] = patch.email;
    if (patch.phone) body['phone'] = patch.phone;
    if (patch.bank) {
      body['bank'] = {
        account_number: patch.bank.accountNumber,
        account_holder: patch.bank.accountHolder,
        ifsc: patch.bank.ifsc,
      };
    }
    if (patch.upiVpa) body['upi'] = { vpa: patch.upiVpa, account_holder: patch.name ?? '' };
    if (patch.pan || patch.gstin) {
      body['kyc_details'] = {
        ...(patch.pan ? { pan: patch.pan } : {}),
        ...(patch.gstin ? { gst: patch.gstin } : {}),
      };
    }

    const res = await this.http.send<CfVendor>({
      method: 'PATCH',
      path: this.paths.updateVendor(vendorRef),
      body,
      idempotencyKey: `vendor-update:${vendorRef}:${JSON.stringify(body).length}`,
    });
    return this.mapVendor(res.body, vendorRef);
  }

  private mapVendor(v: CfVendor, fallbackRef: string): VendorRef {
    return {
      vendorRef: v.vendor_id ?? fallbackRef,
      providerVendorId: String(v.vendor_id ?? fallbackRef),
      status: VENDOR_STATUS_MAP[String(v.status ?? 'PENDING')] ?? 'pending',
      bankVerified: String(v.bank_verification_status ?? '').toUpperCase() === 'VERIFIED' || v.status === 'ACTIVE',
      createdAt: parseDate(v.added_on) ?? new Date(),
    };
  }

  async getVendorBalance(vendorRef: string): Promise<VendorBalance> {
    const res = await this.http.send<CfVendorBalance>({
      method: 'GET',
      path: this.paths.vendorBalance(vendorRef),
    });
    const b = res.body ?? {};
    return {
      vendorRef,
      availableBalance: toPaise(b.vendor_settled_balance ?? b.available_balance ?? 0, 'available_balance'),
      unsettledBalance: toPaise(b.vendor_unsettled_balance ?? b.unsettled_balance ?? 0, 'unsettled_balance'),
      reservedBalance: toPaise(b.vendor_reserved_balance ?? b.reserved_balance ?? 0, 'reserved_balance'),
    };
  }

  async transferToVendor(input: TransferInput): Promise<TransferRef> {
    const res = await this.http.send<CfVendorSettlement>({
      method: 'POST',
      path: this.paths.vendorSettlement(input.vendorRef),
      body: {
        settlement_id: input.transferId,
        amount: toRupees(input.amount),
        remarks: input.remarks.slice(0, 70),
      },
      idempotencyKey: input.idempotencyKey,
    });
    return this.mapTransfer(res.body, input.transferId, input.amount);
  }

  async getTransfer(transferId: string, vendorRef?: string): Promise<TransferRef | null> {
    if (!vendorRef) {
      throw err.validation('transfer.vendor_required', 'vendorRef is required to look up a vendor settlement');
    }
    try {
      const res = await this.http.send<CfVendorSettlement>({
        method: 'GET',
        path: this.paths.getVendorSettlement(vendorRef, transferId),
      });
      return this.mapTransfer(res.body, transferId, 0);
    } catch (e) {
      if ((e as { code?: string }).code === 'pa.http_404') return null;
      throw e;
    }
  }

  private mapTransfer(s: CfVendorSettlement, fallbackId: string, fallbackAmount: Paise): TransferRef {
    return {
      transferId: s.settlement_id ?? fallbackId,
      providerTransferId: String(s.cf_settlement_id ?? ''),
      status: TRANSFER_STATUS_MAP[String(s.status ?? 'PENDING')] ?? 'pending',
      amount: s.amount === undefined ? fallbackAmount : toPaise(s.amount, 'settlement amount'),
      utr: s.utr ? String(s.utr) : null,
      failureReason: s.failure_reason ? String(s.failure_reason) : null,
      processedAt: parseDate(s.processed_on ?? s.settled_on),
    };
  }
}

// ---------------------------------------------------------------------------
// Wire shapes (documented Cashfree responses; only fields we consume)
// ---------------------------------------------------------------------------

interface CfOrder {
  cf_order_id?: string | number;
  order_id?: string;
  order_status?: string;
  order_amount?: number | string;
  payment_session_id?: string;
  order_expiry_time?: string;
}

interface CfPayment {
  cf_payment_id?: string | number;
  order_id?: string;
  payment_status?: string;
  payment_amount?: number | string;
  payment_group?: string;
  payment_method?: unknown;
  payment_time?: string;
  payment_completion_time?: string;
  bank_reference?: string;
  payment_message?: string;
}

interface CfRefund {
  cf_refund_id?: string | number;
  refund_id?: string;
  refund_status?: string;
  refund_amount?: number | string;
  processed_at?: string;
}

interface CfVendor {
  vendor_id?: string;
  status?: string;
  bank_verification_status?: string;
  added_on?: string;
}

interface CfVendorBalance {
  vendor_settled_balance?: number | string;
  vendor_unsettled_balance?: number | string;
  vendor_reserved_balance?: number | string;
  available_balance?: number | string;
  unsettled_balance?: number | string;
  reserved_balance?: number | string;
}

interface CfVendorSettlement {
  cf_settlement_id?: string | number;
  settlement_id?: string;
  status?: string;
  amount?: number | string;
  utr?: string;
  failure_reason?: string;
  processed_on?: string;
  settled_on?: string;
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (Array.isArray(direct)) return direct[0];
  return direct;
}

function describeMethod(group: unknown, method: unknown): string {
  if (typeof group === 'string' && group) return group;
  if (method && typeof method === 'object') {
    const key = Object.keys(method as object)[0];
    if (key) return key;
  }
  return 'unknown';
}

function accountTypeFor(t: VendorRegistration['accountType']): string {
  switch (t) {
    case 'individual':
      return 'Individual';
    case 'proprietorship':
      return 'Proprietorship';
    case 'company':
      return 'Company';
    case 'llp':
      return 'LLP';
    case 'partnership':
      return 'Partnership';
    default:
      return 'Individual';
  }
}

/**
 * Cashfree does not send a dedicated event id, so derive a stable one from the
 * event's own natural key. Two deliveries of the same event collapse to one
 * row in `webhook_events`, which is what makes webhook processing idempotent.
 */
function deriveEventId(type: string, payload: Record<string, unknown>, timestamp: string): string {
  const data = (payload['data'] ?? {}) as Record<string, unknown>;
  const order = (data['order'] ?? {}) as Record<string, unknown>;
  const payment = (data['payment'] ?? {}) as Record<string, unknown>;
  const refund = (data['refund'] ?? {}) as Record<string, unknown>;
  const settlement = (data['settlement'] ?? {}) as Record<string, unknown>;
  const dispute = (data['dispute'] ?? {}) as Record<string, unknown>;
  const vendor = (data['vendor'] ?? {}) as Record<string, unknown>;

  const natural =
    payment['cf_payment_id'] ??
    refund['cf_refund_id'] ??
    refund['refund_id'] ??
    settlement['cf_settlement_id'] ??
    settlement['settlement_id'] ??
    dispute['dispute_id'] ??
    vendor['vendor_id'] ??
    order['order_id'] ??
    timestamp;

  const status =
    payment['payment_status'] ?? refund['refund_status'] ?? settlement['status'] ?? dispute['dispute_status'] ?? '';

  return `${type}:${String(natural)}:${String(status)}`;
}
