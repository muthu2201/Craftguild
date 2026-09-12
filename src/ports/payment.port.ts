import type { Paise } from '../domain/money/money.js';

/**
 * PaymentPort / SettlementPort (blueprint Part 13).
 * The domain and application layers depend only on these shapes. No vendor
 * type ever crosses this boundary.
 */

export type PaymentStatus = 'created' | 'pending' | 'success' | 'failed' | 'user_dropped' | 'cancelled';
export type RefundStatus = 'pending' | 'success' | 'failed' | 'cancelled';
export type TransferStatus = 'pending' | 'processing' | 'success' | 'failed' | 'reversed';

export interface CustomerDetails {
  readonly customerId: string;
  readonly email: string;
  readonly phone: string;
  readonly name?: string;
}

export interface SplitLeg {
  readonly vendorRef: string;
  readonly amount: Paise;
  /** Held back inside the split through the grace window. */
  readonly reserveAmount?: Paise;
  readonly reserveReleaseAt?: Date;
}

export interface CreateOrderInput {
  readonly orderId: string;
  readonly amount: Paise;
  readonly currency: 'INR';
  readonly customer: CustomerDetails;
  readonly idempotencyKey: string;
  readonly returnUrl?: string;
  readonly notifyUrl?: string;
  readonly note?: string;
  readonly expiresAt?: Date;
  readonly splits?: readonly SplitLeg[];
}

export interface OrderRef {
  readonly orderId: string;
  readonly providerOrderId: string;
  readonly paymentSessionId: string;
  readonly status: PaymentStatus;
  readonly amount: Paise;
  readonly expiresAt: Date | null;
}

export interface PaymentResult {
  readonly providerPaymentId: string;
  readonly orderId: string;
  readonly status: PaymentStatus;
  readonly amount: Paise;
  readonly method: string;
  readonly capturedAt: Date | null;
  readonly bankReference: string | null;
  readonly failureReason: string | null;
}

export interface CreateRefundInput {
  readonly orderId: string;
  readonly providerPaymentId: string;
  readonly refundId: string;
  readonly amount: Paise;
  readonly note: string;
  readonly idempotencyKey: string;
  /** Which vendor legs fund the refund. Omitted means the platform funds it. */
  readonly splitRefunds?: readonly { readonly vendorRef: string; readonly amount: Paise }[];
}

export interface RefundRef {
  readonly refundId: string;
  readonly providerRefundId: string;
  readonly status: RefundStatus;
  readonly amount: Paise;
  readonly processedAt: Date | null;
}

export interface PaymentPort {
  createOrder(input: CreateOrderInput): Promise<OrderRef>;
  getOrder(orderId: string): Promise<OrderRef>;
  getPaymentStatus(orderId: string): Promise<PaymentResult | null>;
  createRefund(input: CreateRefundInput): Promise<RefundRef>;
  getRefund(orderId: string, refundId: string): Promise<RefundRef | null>;
  /** Verify a webhook delivery. Returns the parsed envelope or throws. */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): WebhookEnvelope;
}

export interface WebhookEnvelope {
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: Date;
  readonly payload: Record<string, unknown>;
  readonly raw: string;
}

export type VendorKycStatus = 'pending' | 'in_review' | 'active' | 'blocked' | 'rejected';

export interface VendorRegistration {
  readonly vendorRef: string;
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly pan: string;
  readonly accountType: 'individual' | 'proprietorship' | 'company' | 'llp' | 'partnership';
  readonly bank?: { readonly accountNumber: string; readonly ifsc: string; readonly accountHolder: string };
  readonly upiVpa?: string;
  readonly gstin?: string | null;
  readonly scheduleSettlement?: boolean;
}

export interface VendorRef {
  readonly vendorRef: string;
  readonly providerVendorId: string;
  readonly status: VendorKycStatus;
  readonly bankVerified: boolean;
  readonly createdAt: Date;
}

export interface VendorBalance {
  readonly vendorRef: string;
  readonly availableBalance: Paise;
  readonly unsettledBalance: Paise;
  readonly reservedBalance: Paise;
}

export interface TransferInput {
  readonly transferId: string;
  readonly vendorRef: string;
  readonly amount: Paise;
  readonly idempotencyKey: string;
  readonly remarks: string;
}

export interface TransferRef {
  readonly transferId: string;
  readonly providerTransferId: string;
  readonly status: TransferStatus;
  readonly amount: Paise;
  readonly utr: string | null;
  readonly failureReason: string | null;
  readonly processedAt: Date | null;
}

export interface SettlementPort {
  registerVendor(input: VendorRegistration): Promise<VendorRef>;
  getVendor(vendorRef: string): Promise<VendorRef | null>;
  updateVendor(vendorRef: string, patch: Partial<VendorRegistration>): Promise<VendorRef>;
  getVendorBalance(vendorRef: string): Promise<VendorBalance>;
  /** Instruct a payout of settled vendor balance to the creator's own bank/VPA. */
  transferToVendor(input: TransferInput): Promise<TransferRef>;
  getTransfer(transferId: string): Promise<TransferRef | null>;
}
