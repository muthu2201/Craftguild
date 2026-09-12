/**
 * Cashfree API conformance server (TEST INFRASTRUCTURE — never deployed).
 *
 * The application ships one payment adapter: the real
 * `CashfreeAdapter`, which speaks Cashfree's documented HTTP contract. To
 * exercise that adapter end to end without live merchant credentials, this
 * process implements the same contract on the other side of the socket:
 * the same paths, the same auth headers, the same decimal-rupee wire format,
 * the same webhook signing scheme (base64 HMAC-SHA256 over timestamp + body).
 *
 * The application under test is therefore completely unmodified during E2E and
 * stress runs — no in-process fake, no injected stub. Point
 * `CASHFREE_BASE_URL` at a real Cashfree environment and the same adapter
 * talks to Cashfree instead.
 *
 * It also deliberately reproduces the failure modes a real aggregator exhibits
 * — duplicate webhook deliveries, out-of-order deliveries, transient 503s,
 * latency — because those are exactly what the idempotency and reconciliation
 * machinery exists to survive.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';

interface SimOrder {
  cf_order_id: string;
  order_id: string;
  order_amount: number;
  order_currency: string;
  order_status: 'ACTIVE' | 'PAID' | 'EXPIRED' | 'TERMINATED';
  payment_session_id: string;
  order_expiry_time: string | null;
  customer_details: Record<string, unknown>;
  order_splits: { vendor_id: string; amount: number }[];
  notify_url: string | null;
  created_at: string;
}

interface SimPayment {
  cf_payment_id: string;
  order_id: string;
  payment_status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'USER_DROPPED';
  payment_amount: number;
  payment_group: string;
  payment_time: string;
  payment_completion_time: string | null;
  bank_reference: string;
  payment_message: string | null;
}

interface SimRefund {
  cf_refund_id: string;
  refund_id: string;
  order_id: string;
  refund_status: 'PENDING' | 'SUCCESS' | 'FAILED';
  refund_amount: number;
  processed_at: string | null;
  refund_splits: { vendor_id: string; amount: number }[];
}

interface SimVendor {
  vendor_id: string;
  status: 'ACTIVE' | 'IN_BENE_CREATION' | 'BLOCKED';
  name: string;
  email: string;
  phone: string;
  bank_verification_status: string;
  added_on: string;
  kyc_details: Record<string, unknown>;
  settled_balance: number;
  unsettled_balance: number;
}

interface SimSettlement {
  cf_settlement_id: string;
  settlement_id: string;
  vendor_id: string;
  amount: number;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  utr: string | null;
  failure_reason: string | null;
  processed_on: string | null;
}

export interface SimConfig {
  port: number;
  appId: string;
  secretKey: string;
  webhookSecret: string;
  /** Probability [0,1] that a mutating call returns a transient 503 before succeeding. */
  transientFailureRate: number;
  /** Probability that a webhook is delivered twice. */
  duplicateWebhookRate: number;
  /** Probability that a vendor settlement fails (bank bounce). */
  payoutFailureRate: number;
  /** Artificial latency in milliseconds added to every response. */
  latencyMs: number;
  /** Deterministic seed so a stress run can be replayed exactly. */
  seed: number;
}

export const DEFAULT_SIM_CONFIG: SimConfig = {
  port: 9099,
  appId: 'TEST_APP_ID',
  secretKey: 'TEST_SECRET_KEY',
  webhookSecret: 'TEST_SECRET_KEY',
  transientFailureRate: 0,
  duplicateWebhookRate: 0,
  payoutFailureRate: 0,
  latencyMs: 0,
  seed: 42,
};

/** Deterministic PRNG (mulberry32) so failure injection is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class CashfreeSimulator {
  private readonly orders = new Map<string, SimOrder>();
  private readonly paymentsByOrder = new Map<string, SimPayment[]>();
  private readonly refunds = new Map<string, SimRefund>();
  private readonly vendors = new Map<string, SimVendor>();
  private readonly settlements = new Map<string, SimSettlement>();
  private readonly idempotency = new Map<string, unknown>();
  private readonly server = createServer((req, res) => void this.handle(req, res));
  private readonly rng: () => number;
  private webhookQueue: { url: string; body: string; type: string }[] = [];
  private deliveryInFlight = false;

  readonly stats = {
    ordersCreated: 0,
    paymentsCaptured: 0,
    refundsCreated: 0,
    settlementsRequested: 0,
    settlementsFailed: 0,
    webhooksDelivered: 0,
    duplicatesDelivered: 0,
    transientFailures: 0,
    requests: 0,
  };

  constructor(private readonly config: SimConfig = DEFAULT_SIM_CONFIG) {
    this.rng = mulberry32(config.seed);
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(this.config.port, '127.0.0.1', resolve));
    const address = this.server.address();
    return typeof address === 'object' && address ? address.port : this.config.port;
  }

  async close(): Promise<void> {
    await this.drainWebhooks();
    await new Promise<void>((resolve, reject) =>
      this.server.close((e) => (e ? reject(e) : resolve())),
    );
  }

  /** Wait until every queued webhook has been delivered. */
  async drainWebhooks(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((this.webhookQueue.length > 0 || this.deliveryInFlight) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  // -------------------------------------------------------------------------
  // Test-driver API: simulate what a reader does at the hosted checkout.
  // -------------------------------------------------------------------------

  /** Simulate a successful payment against an order, then deliver the webhook. */
  payOrder(orderId: string, method = 'upi'): SimPayment {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`sim: unknown order ${orderId}`);
    if (order.order_status === 'PAID') return this.paymentsByOrder.get(orderId)![0]!;

    const now = new Date().toISOString();
    const payment: SimPayment = {
      cf_payment_id: `${Date.now()}${Math.floor(this.rng() * 1e6)}`,
      order_id: orderId,
      payment_status: 'SUCCESS',
      payment_amount: order.order_amount,
      payment_group: method,
      payment_time: now,
      payment_completion_time: now,
      bank_reference: `BANKREF${Math.floor(this.rng() * 1e10)}`,
      payment_message: null,
    };

    order.order_status = 'PAID';
    this.paymentsByOrder.set(orderId, [payment]);
    this.stats.paymentsCaptured++;

    // Credit the vendor legs, which is what Easy Split does at capture.
    for (const split of order.order_splits) {
      const vendor = this.vendors.get(split.vendor_id);
      if (vendor) vendor.unsettled_balance += split.amount;
    }

    this.enqueueWebhook(order.notify_url, 'PAYMENT_SUCCESS_WEBHOOK', {
      order: { order_id: orderId, order_amount: order.order_amount, order_currency: order.order_currency },
      payment: {
        cf_payment_id: payment.cf_payment_id,
        payment_status: 'SUCCESS',
        payment_amount: payment.payment_amount,
        payment_currency: 'INR',
        payment_time: payment.payment_time,
        payment_completion_time: payment.payment_completion_time,
        payment_group: payment.payment_group,
        bank_reference: payment.bank_reference,
      },
      customer_details: order.customer_details,
    });

    return payment;
  }

  failOrder(orderId: string, dropped = false): void {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`sim: unknown order ${orderId}`);
    const now = new Date().toISOString();
    const payment: SimPayment = {
      cf_payment_id: `${Date.now()}${Math.floor(this.rng() * 1e6)}`,
      order_id: orderId,
      payment_status: dropped ? 'USER_DROPPED' : 'FAILED',
      payment_amount: order.order_amount,
      payment_group: 'upi',
      payment_time: now,
      payment_completion_time: null,
      bank_reference: '',
      payment_message: dropped ? 'user dropped at checkout' : 'issuer declined',
    };
    this.paymentsByOrder.set(orderId, [payment]);
    this.enqueueWebhook(
      order.notify_url,
      dropped ? 'PAYMENT_USER_DROPPED_WEBHOOK' : 'PAYMENT_FAILED_WEBHOOK',
      { order: { order_id: orderId }, payment: { cf_payment_id: payment.cf_payment_id, payment_status: payment.payment_status } },
    );
  }

  /** Raise a chargeback against a captured payment. */
  raiseDispute(orderId: string, amountRupees: number, notifyUrl: string): string {
    const payments = this.paymentsByOrder.get(orderId);
    if (!payments || payments.length === 0) throw new Error(`sim: no payment for order ${orderId}`);
    const disputeId = `dsp_${randomUUID().slice(0, 12)}`;
    this.enqueueWebhook(notifyUrl, 'PAYMENT_DISPUTE_WEBHOOK', {
      dispute: {
        dispute_id: disputeId,
        cf_payment_id: payments[0]!.cf_payment_id,
        order_id: orderId,
        dispute_amount: amountRupees,
        dispute_type: 'CHARGEBACK',
        reason: 'fraudulent transaction reported by cardholder',
        dispute_status: 'DISPUTE_CREATED',
      },
    });
    return disputeId;
  }

  /** Deliver the asynchronous result of a vendor settlement. */
  completeSettlement(settlementId: string, notifyUrl: string, succeed = true): void {
    const settlement = this.settlements.get(settlementId);
    if (!settlement) throw new Error(`sim: unknown settlement ${settlementId}`);
    settlement.status = succeed ? 'SUCCESS' : 'FAILED';
    settlement.utr = succeed ? `UTR${Math.floor(this.rng() * 1e12)}` : null;
    settlement.failure_reason = succeed ? null : 'beneficiary account closed';
    settlement.processed_on = new Date().toISOString();

    this.enqueueWebhook(notifyUrl, 'VENDOR_SETTLEMENT_WEBHOOK', {
      settlement: {
        cf_settlement_id: settlement.cf_settlement_id,
        settlement_id: settlement.settlement_id,
        vendor_id: settlement.vendor_id,
        amount: settlement.amount,
        status: settlement.status,
        utr: settlement.utr,
        failure_reason: settlement.failure_reason,
        processed_on: settlement.processed_on,
      },
    });
  }

  pendingSettlements(): SimSettlement[] {
    return [...this.settlements.values()].filter((s) => s.status === 'PENDING');
  }

  getOrder(orderId: string): SimOrder | undefined {
    return this.orders.get(orderId);
  }

  // -------------------------------------------------------------------------
  // HTTP contract
  // -------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.stats.requests++;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks).toString('utf8');

    if (this.config.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.config.latencyMs));
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    // Auth, exactly as Cashfree enforces it.
    if (!path.startsWith('/__sim')) {
      const clientId = req.headers['x-client-id'];
      const clientSecret = req.headers['x-client-secret'];
      const apiVersion = req.headers['x-api-version'];
      if (clientId !== this.config.appId || clientSecret !== this.config.secretKey) {
        return this.send(res, 401, { message: 'authentication failed', code: 'authentication_error', type: 'authentication_error' });
      }
      if (!apiVersion) {
        return this.send(res, 400, { message: 'x-api-version is required', code: 'api_version_missing', type: 'invalid_request_error' });
      }
    }

    // Transient-failure injection on mutating calls only.
    if (method !== 'GET' && !path.startsWith('/__sim') && this.rng() < this.config.transientFailureRate) {
      this.stats.transientFailures++;
      res.setHeader('retry-after', '1');
      return this.send(res, 503, { message: 'service temporarily unavailable', type: 'api_error' });
    }

    // Provider-side idempotency: a repeated key returns the first response.
    const idemKey = req.headers['x-idempotency-key'];
    if (typeof idemKey === 'string' && method !== 'GET') {
      const cached = this.idempotency.get(`${path}:${idemKey}`);
      if (cached !== undefined) return this.send(res, 200, cached);
    }

    let body: Record<string, unknown> = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return this.send(res, 400, { message: 'invalid JSON', type: 'invalid_request_error' });
      }
    }

    const respond = (status: number, payload: unknown) => {
      if (typeof idemKey === 'string' && method !== 'GET' && status >= 200 && status < 300) {
        this.idempotency.set(`${path}:${idemKey}`, payload);
      }
      this.send(res, status, payload);
    };

    try {
      // -- PG orders --
      if (method === 'POST' && path === '/pg/orders') return respond(200, this.createOrder(body));

      const orderMatch = /^\/pg\/orders\/([^/]+)$/.exec(path);
      if (method === 'GET' && orderMatch) {
        const order = this.orders.get(decodeURIComponent(orderMatch[1]!));
        return order
          ? respond(200, order)
          : respond(404, { message: 'order not found', type: 'invalid_request_error' });
      }

      const paymentsMatch = /^\/pg\/orders\/([^/]+)\/payments$/.exec(path);
      if (method === 'GET' && paymentsMatch) {
        return respond(200, this.paymentsByOrder.get(decodeURIComponent(paymentsMatch[1]!)) ?? []);
      }

      const refundMatch = /^\/pg\/orders\/([^/]+)\/refunds$/.exec(path);
      if (method === 'POST' && refundMatch) {
        return respond(200, this.createRefund(decodeURIComponent(refundMatch[1]!), body));
      }

      const getRefundMatch = /^\/pg\/orders\/([^/]+)\/refunds\/([^/]+)$/.exec(path);
      if (method === 'GET' && getRefundMatch) {
        const refund = this.refunds.get(decodeURIComponent(getRefundMatch[2]!));
        return refund
          ? respond(200, refund)
          : respond(404, { message: 'refund not found', type: 'invalid_request_error' });
      }

      // -- Easy Split vendors --
      if (method === 'POST' && path === '/pg/easy-split/vendors') return respond(200, this.createVendor(body));

      const vendorMatch = /^\/pg\/easy-split\/vendors\/([^/]+)$/.exec(path);
      if (vendorMatch) {
        const vendorId = decodeURIComponent(vendorMatch[1]!);
        if (method === 'GET') {
          const vendor = this.vendors.get(vendorId);
          return vendor
            ? respond(200, vendor)
            : respond(404, { message: 'vendor not found', type: 'invalid_request_error' });
        }
        if (method === 'PATCH') return respond(200, this.updateVendor(vendorId, body));
      }

      const balanceMatch = /^\/pg\/easy-split\/vendors\/([^/]+)\/balances$/.exec(path);
      if (method === 'GET' && balanceMatch) {
        const vendor = this.vendors.get(decodeURIComponent(balanceMatch[1]!));
        if (!vendor) return respond(404, { message: 'vendor not found', type: 'invalid_request_error' });
        return respond(200, {
          vendor_settled_balance: vendor.settled_balance,
          vendor_unsettled_balance: vendor.unsettled_balance,
          vendor_reserved_balance: 0,
        });
      }

      const settlementMatch = /^\/pg\/easy-split\/vendors\/([^/]+)\/settlements$/.exec(path);
      if (method === 'POST' && settlementMatch) {
        return respond(200, this.createSettlement(decodeURIComponent(settlementMatch[1]!), body));
      }

      const getSettlementMatch = /^\/pg\/easy-split\/vendors\/([^/]+)\/settlements\/([^/]+)$/.exec(path);
      if (method === 'GET' && getSettlementMatch) {
        const settlement = this.settlements.get(decodeURIComponent(getSettlementMatch[2]!));
        return settlement
          ? respond(200, settlement)
          : respond(404, { message: 'settlement not found', type: 'invalid_request_error' });
      }

      // -- simulator control plane --
      if (path === '/__sim/stats') return this.send(res, 200, this.stats);
      if (path === '/__sim/health') return this.send(res, 200, { ok: true });

      return this.send(res, 404, { message: `no route for ${method} ${path}`, type: 'invalid_request_error' });
    } catch (e) {
      return this.send(res, 400, { message: (e as Error).message, type: 'invalid_request_error' });
    }
  }

  private createOrder(body: Record<string, unknown>): SimOrder {
    const orderId = String(body['order_id'] ?? '');
    if (!orderId) throw new Error('order_id is required');

    const existing = this.orders.get(orderId);
    if (existing) return existing;

    const amount = Number(body['order_amount']);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('order_amount must be a positive number');

    const meta = (body['order_meta'] ?? {}) as Record<string, unknown>;
    const splits = Array.isArray(body['order_splits'])
      ? (body['order_splits'] as Record<string, unknown>[]).map((s) => ({
          vendor_id: String(s['vendor_id']),
          amount: Number(s['amount'] ?? 0),
        }))
      : [];

    for (const split of splits) {
      if (!this.vendors.has(split.vendor_id)) {
        throw new Error(`vendor ${split.vendor_id} is not registered`);
      }
    }
    const splitTotal = splits.reduce((a, s) => a + s.amount, 0);
    if (splitTotal > amount + 1e-9) throw new Error('order_splits exceed order_amount');

    const order: SimOrder = {
      cf_order_id: `cf_${randomUUID().slice(0, 16)}`,
      order_id: orderId,
      order_amount: amount,
      order_currency: String(body['order_currency'] ?? 'INR'),
      order_status: 'ACTIVE',
      payment_session_id: `session_${randomUUID().replace(/-/g, '')}`,
      order_expiry_time: body['order_expiry_time'] ? String(body['order_expiry_time']) : null,
      customer_details: (body['customer_details'] ?? {}) as Record<string, unknown>,
      order_splits: splits,
      notify_url: meta['notify_url'] ? String(meta['notify_url']) : null,
      created_at: new Date().toISOString(),
    };
    this.orders.set(orderId, order);
    this.stats.ordersCreated++;
    return order;
  }

  private createRefund(orderId: string, body: Record<string, unknown>): SimRefund {
    const order = this.orders.get(orderId);
    if (!order) throw new Error('order not found');
    if (order.order_status !== 'PAID') throw new Error('order is not paid');

    const refundId = String(body['refund_id'] ?? '');
    const existing = this.refunds.get(refundId);
    if (existing) return existing;

    const amount = Number(body['refund_amount']);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('refund_amount must be positive');

    const alreadyRefunded = [...this.refunds.values()]
      .filter((r) => r.order_id === orderId && r.refund_status !== 'FAILED')
      .reduce((a, r) => a + r.refund_amount, 0);
    if (alreadyRefunded + amount > order.order_amount + 1e-9) {
      throw new Error('refund exceeds the captured amount');
    }

    const refund: SimRefund = {
      cf_refund_id: `cfr_${randomUUID().slice(0, 12)}`,
      refund_id: refundId,
      order_id: orderId,
      refund_status: 'PENDING',
      refund_amount: amount,
      processed_at: null,
      refund_splits: Array.isArray(body['refund_splits'])
        ? (body['refund_splits'] as Record<string, unknown>[]).map((s) => ({
            vendor_id: String(s['vendor_id']),
            amount: Number(s['amount'] ?? 0),
          }))
        : [],
    };
    this.refunds.set(refundId, refund);
    this.stats.refundsCreated++;

    // Real refunds settle asynchronously; deliver the terminal webhook shortly.
    setTimeout(() => {
      refund.refund_status = 'SUCCESS';
      refund.processed_at = new Date().toISOString();
      this.enqueueWebhook(order.notify_url, 'REFUND_STATUS_WEBHOOK', {
        refund: {
          cf_refund_id: refund.cf_refund_id,
          refund_id: refund.refund_id,
          order_id: orderId,
          refund_status: 'SUCCESS',
          refund_amount: refund.refund_amount,
          processed_at: refund.processed_at,
        },
      });
    }, 5).unref?.();

    return refund;
  }

  private createVendor(body: Record<string, unknown>): SimVendor {
    const vendorId = String(body['vendor_id'] ?? '');
    if (!vendorId) throw new Error('vendor_id is required');
    const existing = this.vendors.get(vendorId);
    if (existing) return existing;

    const kyc = (body['kyc_details'] ?? {}) as Record<string, unknown>;
    const pan = String(kyc['pan'] ?? '');
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) throw new Error('kyc_details.pan is invalid');

    const bank = body['bank'] as Record<string, unknown> | undefined;
    const upi = body['upi'] as Record<string, unknown> | undefined;
    if (!bank && !upi) throw new Error('either bank or upi must be supplied');
    if (bank && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(bank['ifsc'] ?? ''))) {
      throw new Error('bank.ifsc is invalid');
    }

    const vendor: SimVendor = {
      vendor_id: vendorId,
      status: 'ACTIVE',
      name: String(body['name'] ?? ''),
      email: String(body['email'] ?? ''),
      phone: String(body['phone'] ?? ''),
      bank_verification_status: 'VERIFIED',
      added_on: new Date().toISOString(),
      kyc_details: kyc,
      settled_balance: 0,
      unsettled_balance: 0,
    };
    this.vendors.set(vendorId, vendor);
    return vendor;
  }

  private updateVendor(vendorId: string, body: Record<string, unknown>): SimVendor {
    const vendor = this.vendors.get(vendorId);
    if (!vendor) throw new Error('vendor not found');
    if (body['name']) vendor.name = String(body['name']);
    if (body['email']) vendor.email = String(body['email']);
    if (body['phone']) vendor.phone = String(body['phone']);
    return vendor;
  }

  private createSettlement(vendorId: string, body: Record<string, unknown>): SimSettlement {
    const vendor = this.vendors.get(vendorId);
    if (!vendor) throw new Error('vendor not found');

    const settlementId = String(body['settlement_id'] ?? '');
    if (!settlementId) throw new Error('settlement_id is required');
    const existing = this.settlements.get(settlementId);
    if (existing) return existing;

    const amount = Number(body['amount']);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be positive');

    this.stats.settlementsRequested++;
    const fails = this.rng() < this.config.payoutFailureRate;
    if (fails) this.stats.settlementsFailed++;

    const settlement: SimSettlement = {
      cf_settlement_id: `cfs_${randomUUID().slice(0, 12)}`,
      settlement_id: settlementId,
      vendor_id: vendorId,
      amount,
      status: fails ? 'FAILED' : 'SUCCESS',
      utr: fails ? null : `UTR${Math.floor(this.rng() * 1e12)}`,
      failure_reason: fails ? 'beneficiary account closed' : null,
      processed_on: new Date().toISOString(),
    };
    this.settlements.set(settlementId, settlement);

    if (!fails) {
      vendor.unsettled_balance = Math.max(0, vendor.unsettled_balance - amount);
      vendor.settled_balance += amount;
    }
    return settlement;
  }

  // -------------------------------------------------------------------------
  // Webhook delivery, signed exactly as Cashfree signs
  // -------------------------------------------------------------------------

  private enqueueWebhook(url: string | null, type: string, data: Record<string, unknown>): void {
    if (!url) return;
    const body = JSON.stringify({ data, event_time: new Date().toISOString(), type });
    this.webhookQueue.push({ url, body, type });
    if (this.rng() < this.config.duplicateWebhookRate) {
      this.webhookQueue.push({ url, body, type });
      this.stats.duplicatesDelivered++;
    }
    void this.pumpWebhooks();
  }

  private async pumpWebhooks(): Promise<void> {
    if (this.deliveryInFlight) return;
    this.deliveryInFlight = true;
    try {
      while (this.webhookQueue.length > 0) {
        const batch = this.webhookQueue.splice(0, 16);
        await Promise.all(batch.map((item) => this.deliver(item)));
      }
    } finally {
      this.deliveryInFlight = false;
    }
  }

  private async deliver(item: { url: string; body: string; type: string }): Promise<void> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', this.config.webhookSecret)
      .update(timestamp + item.body)
      .digest('base64');

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(item.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-webhook-signature': signature,
            'x-webhook-timestamp': timestamp,
            'x-webhook-version': '2022-09-01',
          },
          body: item.body,
        });
        if (res.ok) {
          this.stats.webhooksDelivered++;
          return;
        }
      } catch {
        /* retry below, exactly as the aggregator would */
      }
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }

  private send(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }
}

// Standalone mode: `npm run sim`
const invokedDirectly = process.argv[1]?.includes('cashfree-sim');
if (invokedDirectly) {
  const sim = new CashfreeSimulator({
    ...DEFAULT_SIM_CONFIG,
    port: Number(process.env['SIM_PORT'] ?? 9099),
    appId: process.env['CASHFREE_APP_ID'] ?? DEFAULT_SIM_CONFIG.appId,
    secretKey: process.env['CASHFREE_SECRET_KEY'] ?? DEFAULT_SIM_CONFIG.secretKey,
    webhookSecret: process.env['CASHFREE_WEBHOOK_SECRET'] ?? DEFAULT_SIM_CONFIG.webhookSecret,
  });
  void sim.listen().then((port) => {
    // eslint-disable-next-line no-console
    console.log(`cashfree conformance server listening on http://127.0.0.1:${port}`);
  });
}
