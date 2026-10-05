import { PaymentChannel } from '@prisma/client';
import { config } from '../../config/env';
import { logger } from '../../lib/logger';
import { generateToken } from '../../utils/ids';

/**
 * ---------------------------------------------------------------------------
 * Payment gateway abstraction
 * ---------------------------------------------------------------------------
 *
 * EasyTrip talks to a Hyperswitch-compatible payment router. Because merchant
 * integrations require external accounts, the platform ships two adapters:
 *
 *   - `mock`    deterministic, test-card driven; used by default and in CI.
 *   - `hyper`   real Hyperswitch REST calls, selected with PAYMENT_PROVIDER.
 *
 * Both satisfy the same `PaymentGateway` contract, so the booking flow is
 * identical in dev and prod. This is a payment *channel* concern only - it is
 * unrelated to travel supplier connectivity.
 */

export type CreatePaymentInput = {
  amountCents: number;
  currency: string;
  orderId: string;
  orderNumber: string;
  customerEmail: string;
  method: PaymentChannel;
  idempotencyKey: string;
  returnUrl?: string;
  card?: {
    number: string;
    expMonth: number;
    expYear: number;
    cvc: string;
    holderName?: string;
  };
};

export type CreatePaymentResult = {
  provider: string;
  providerIntentId: string;
  status: 'INITIATED' | 'REQUIRES_ACTION' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED';
  clientSecret?: string;
  redirectUrl?: string;
  cardBrand?: string;
  cardLast4?: string;
  failureCode?: string;
  failureMessage?: string;
};

export type CaptureResult = {
  providerChargeId: string;
  status: 'CAPTURED' | 'FAILED';
  failureMessage?: string;
};

export type RefundResult = {
  providerRefundId: string;
  status: 'SUCCEEDED' | 'FAILED';
  failureMessage?: string;
};

export interface PaymentGateway {
  /** Gateway identifier, surfaced in the Payment.provider column. */
  readonly name: string;
  createIntent(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  capture(providerIntentId: string, amountCents: number): Promise<CaptureResult>;
  refund(providerChargeId: string, amountCents: number, idempotencyKey: string): Promise<RefundResult>;
  healthCheck(): Promise<boolean>;
}

/** Detects the network brand from a card number for display purposes. */
function detectBrand(cardNumber: string): string {
  const digits = cardNumber.replace(/\D/g, '');
  if (/^4/.test(digits)) return 'visa';
  if (/^5[1-5]/.test(digits) || /^2[2-7]/.test(digits)) return 'mastercard';
  if (/^3[47]/.test(digits)) return 'amex';
  if (/^6(?:011|5)/.test(digits)) return 'discover';
  if (/^3(?:0[0-5]|[68])/.test(digits)) return 'diners';
  return 'card';
}

export function luhnValid(cardNumber: string): boolean {
  const digits = cardNumber.replace(/\D/g, '');
  if (digits.length < 12) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Deterministic mock gateway.
 *
 * Test cards (documented in the README):
 *   4242 4242 4242 4242  -> approved
 *   4000 0000 0000 0002  -> declined
 *   4000 0000 0000 0119  -> processing failure
 *   4000 0000 0000 3220  -> requires 3-D Secure step-up
 */
class MockPaymentGateway implements PaymentGateway {
  readonly name = 'mock';

  async createIntent(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const providerIntentId = `mock_pi_${generateToken(12)}`;
    const digits = input.card?.number.replace(/\D/g, '') ?? '';

    if (digits && !luhnValid(digits)) {
      return {
        provider: this.name,
        providerIntentId,
        status: 'FAILED',
        failureCode: 'invalid_number',
        failureMessage: 'The card number is not valid',
      };
    }

    const brand = digits ? detectBrand(digits) : undefined;
    const last4 = digits ? digits.slice(-4) : undefined;

    if (digits.endsWith(config.payments.declineSuffix)) {
      return {
        provider: this.name,
        providerIntentId,
        status: 'FAILED',
        cardBrand: brand,
        cardLast4: last4,
        failureCode: 'card_declined',
        failureMessage: 'Your card was declined. Try another payment method.',
      };
    }

    if (digits.endsWith(config.payments.failureSuffix)) {
      return {
        provider: this.name,
        providerIntentId,
        status: 'FAILED',
        cardBrand: brand,
        cardLast4: last4,
        failureCode: 'processing_error',
        failureMessage: 'The payment could not be processed. Please try again.',
      };
    }

    if (digits.endsWith('3220')) {
      return {
        provider: this.name,
        providerIntentId,
        status: 'REQUIRES_ACTION',
        clientSecret: `${providerIntentId}_secret_requires_action`,
        cardBrand: brand,
        cardLast4: last4,
      };
    }

    logger.info('payment.mock_intent_created', { providerIntentId, amountCents: input.amountCents });

    // The mock gateway models an automatic-capture flow: an approved card is
    // captured immediately, so callers can fulfil the order in the same
    // request rather than waiting for a webhook.
    return {
      provider: this.name,
      providerIntentId,
      status: 'CAPTURED',
      clientSecret: `${providerIntentId}_secret`,
      cardBrand: brand,
      cardLast4: last4,
    };
  }

  async capture(_providerIntentId: string): Promise<CaptureResult> {
    return { providerChargeId: `mock_ch_${generateToken(10)}`, status: 'CAPTURED' };
  }

  async refund(_providerChargeId: string): Promise<RefundResult> {
    return { providerRefundId: `mock_re_${generateToken(10)}`, status: 'SUCCEEDED' };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

/** Real Hyperswitch REST adapter. */
class HyperswitchPaymentGateway implements PaymentGateway {
  readonly name = 'hyperswitch';

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${config.payments.baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.payments.apiKey}`,
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Hyperswitch ${path} failed (${response.status}): ${body}`);
    }
    return (await response.json()) as T;
  }

  async createIntent(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const payload = {
      amount: input.amountCents,
      currency: input.currency.toLowerCase(),
      capture_method: 'automatic',
      confirm: true,
      description: `EasyTrip order ${input.orderNumber}`,
      metadata: { order_id: input.orderId, order_number: input.orderNumber },
      email: input.customerEmail,
      mandate: input.method === PaymentChannel.CARD ? 'off_session' : 'off_session',
    };

    const result = await this.request<{
      payment_intent?: { id: string; status: string; client_secret?: string };
      error?: { code: string; message: string };
    }>('/payments', {
      method: 'POST',
      headers: { 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify(payload),
    });

    if (result.error || !result.payment_intent) {
      return {
        provider: this.name,
        providerIntentId: '',
        status: 'FAILED',
        failureCode: result.error?.code ?? 'provider_error',
        failureMessage: result.error?.message ?? 'Payment could not be created',
      };
    }

    const intent = result.payment_intent;
    const statusMap: Record<string, CreatePaymentResult['status']> = {
      requires_payment_method: 'INITIATED',
      requires_action: 'REQUIRES_ACTION',
      requires_confirmation: 'REQUIRES_ACTION',
      processing: 'INITIATED',
      authorized: 'AUTHORIZED',
      succeeded: 'CAPTURED',
      failed: 'FAILED',
    };

    return {
      provider: this.name,
      providerIntentId: intent.id,
      status: statusMap[intent.status] ?? 'INITIATED',
      clientSecret: intent.client_secret,
    };
  }

  async capture(providerIntentId: string): Promise<CaptureResult> {
    const result = await this.request<{ status?: string }>(`/payments/${providerIntentId}/capture`, {
      method: 'POST',
    });
    return {
      providerChargeId: providerIntentId,
      status: result.status === 'succeeded' ? 'CAPTURED' : 'FAILED',
      failureMessage: result.status === 'succeeded' ? undefined : 'Capture was rejected',
    };
  }

  async refund(providerChargeId: string, amountCents: number, idempotencyKey: string): Promise<RefundResult> {
    const result = await this.request<{ refund?: { id: string; status: string } }>(
      `/refunds/${providerChargeId}`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ amount: amountCents }),
      },
    );
    return {
      providerRefundId: result.refund?.id ?? '',
      status: result.refund?.status === 'succeeded' ? 'SUCCEEDED' : 'FAILED',
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.request('/health');
      return true;
    } catch {
      return false;
    }
  }
}

let gateway: PaymentGateway | null = null;

export function getPaymentGateway(): PaymentGateway {
  if (gateway) return gateway;
  gateway = config.payments.provider === 'hyper' && config.payments.baseUrl
    ? new HyperswitchPaymentGateway()
    : new MockPaymentGateway();

  logger.info('payment.gateway_ready', { provider: gateway.name });
  return gateway;
}

/** Bank/wallet rails that always succeed, used for vouchers and credit. */
export const OFFLINE_METHODS: PaymentChannel[] = [
  PaymentChannel.VOUCHER,
  PaymentChannel.BANK_TRANSFER,
  PaymentChannel.CASH_ON_SITE,
];

export function isOfflineMethod(method: PaymentChannel): boolean {
  return OFFLINE_METHODS.includes(method);
}