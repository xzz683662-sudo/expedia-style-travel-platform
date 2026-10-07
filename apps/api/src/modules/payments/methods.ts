import { createHash } from 'node:crypto';
import { CredentialClass, PaymentChannel } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../utils/errors';

/**
 * ---------------------------------------------------------------------------
 * Saved payment methods
 * ---------------------------------------------------------------------------
 *
 * Account-scoped storage for reusable payment credentials. Two rules govern it,
 * and both are enforced rather than documented:
 *
 *   1. **Never store a secret.** No PAN, no expiry, no CVC — only a
 *      gateway-issued token (or, for a self-custodial crypto rail, the public
 *      receiving address) and the display fragments the shopper already sees.
 *      Storing a card number would pull the platform into PCI scope for no gain.
 *      `pnpm credentials:contract` greps for the forbidden field names.
 *
 *   2. **Storing is not settling.** Every method here is class `SETTLEMENT`,
 *      because that is what it authorises. Whether it can actually be *used*
 *      is decided by the credential boundary — the settlement adapters refuse
 *      `live` in this stage (see `modules/payments/gateway.ts`).
 *
 * The Tron address is checksum-validated rather than pattern-matched. A typo in
 * a receiving address is an irreversible loss, so "looks like a Tron address" is
 * not good enough.
 */

// ---------------------------------------------------------------------------
// Base58Check (Tron addresses are base58check over a 0x41-prefixed payload)
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(input: string): Buffer | null {
  let num = 0n;
  for (const char of input) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index === -1) return null;
    num = num * 58n + BigInt(index);
  }
  // Preserve leading zero bytes (each leading '1' is one 0x00).
  let hex = num.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const leadingZeros = input.match(/^1*/)?.[0].length ?? 0;
  return Buffer.concat([Buffer.alloc(leadingZeros), Buffer.from(hex, 'hex')]);
}

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

/**
 * Validates a Tron (TRC20) address.
 *
 * Decodes base58check, requires a `0x41` network byte, a 20-byte body and a
 * matching double-SHA256 checksum. This is the same check a wallet performs, so
 * a mistyped address is rejected before it can ever receive funds.
 */
export function isValidTronAddress(address: string): boolean {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;

  const decoded = base58Decode(address);
  if (!decoded || decoded.length !== 25) return false;

  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21);
  if (payload[0] !== 0x41) return false;

  const expected = sha256(sha256(payload)).subarray(0, 4);
  return checksum.equals(expected);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface AddPaymentMethodInput {
  channel: PaymentChannel;
  label?: string;
  isDefault?: boolean;
  /** Cards: display fragments only. A gateway token, never the number. */
  card?: { brand: string; last4: string; token?: string; expMonth?: number; expYear?: number };
  /** PayPal: the payer id the gateway issued. */
  paypal?: { payerId: string; email?: string };
  /** TRC20: the public receiving address (validated) plus an optional label. */
  crypto?: { address: string; network?: string };
}

/** The display fragments we are willing to persist, per channel. */
function deriveStored(input: AddPaymentMethodInput): {
  brand: string | null;
  last4: string | null;
  providerToken: string | null;
  expiresAt: Date | null;
  metadata: Record<string, unknown> | null;
} {
  switch (input.channel) {
    case PaymentChannel.CARD: {
      const card = input.card;
      if (!card) throw AppError.validation('card details are required for a card payment method');
      const last4 = card.last4.replace(/\D/g, '');
      if (!/^\d{4}$/.test(last4)) throw AppError.validation('last4 must be exactly four digits');
      // Guard against a caller trying to smuggle a full number into last4.
      if (last4.length !== 4) throw AppError.validation('only the last four digits may be stored');
      return {
        brand: card.brand.toLowerCase().slice(0, 20),
        last4,
        providerToken: card.token ?? null,
        expiresAt:
          card.expYear && card.expMonth
            ? new Date(Date.UTC(card.expYear, card.expMonth - 1, 1))
            : null,
        metadata: null,
      };
    }

    case PaymentChannel.PAYPAL: {
      const paypal = input.paypal;
      if (!paypal?.payerId) throw AppError.validation('paypal.payerId is required');
      return {
        brand: 'paypal',
        last4: paypal.email ? paypal.email.slice(-4) : null,
        providerToken: paypal.payerId,
        expiresAt: null,
        metadata: paypal.email ? { email: paypal.email } : null,
      };
    }

    case PaymentChannel.CRYPTO_TRC20: {
      const crypto = input.crypto;
      if (!crypto?.address) throw AppError.validation('crypto.address is required');
      if ((crypto.network ?? 'tron') !== 'tron') {
        throw AppError.validation('only the tron network is supported for TRC20');
      }
      if (!isValidTronAddress(crypto.address)) {
        throw AppError.validation('that is not a valid Tron (TRC20) address');
      }
      return {
        brand: 'trc20',
        // An address is public; showing the last six is enough to disambiguate.
        last4: crypto.address.slice(-6),
        providerToken: crypto.address,
        expiresAt: null,
        metadata: { network: 'tron' },
      };
    }

    default:
      throw AppError.validation(`channel ${input.channel} cannot be saved to an account`);
  }
}

export function listPaymentMethods(userId: string) {
  return prisma.paymentMethod.findMany({
    where: { userId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function addPaymentMethod(userId: string, input: AddPaymentMethodInput) {
  const stored = deriveStored(input);

  const count = await prisma.paymentMethod.count({ where: { userId } });
  // The first method saved becomes the default; a later one only if asked.
  const isDefault = input.isDefault ?? count === 0;

  return prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.paymentMethod.updateMany({ where: { userId }, data: { isDefault: false } });
    }
    return tx.paymentMethod.create({
      data: {
        userId,
        channel: input.channel,
        brand: stored.brand,
        last4: stored.last4,
        label: input.label?.trim().slice(0, 80) ?? null,
        providerToken: stored.providerToken,
        credentialClass: CredentialClass.SETTLEMENT,
        isDefault,
        expiresAt: stored.expiresAt,
        metadata: (stored.metadata ?? undefined) as never,
      },
    });
  });
}

export async function removePaymentMethod(userId: string, id: string) {
  const method = await prisma.paymentMethod.findUnique({ where: { id } });
  if (!method || method.userId !== userId) throw AppError.notFound('Payment method');

  await prisma.$transaction(async (tx) => {
    await tx.paymentMethod.delete({ where: { id } });
    // Promote another method so the account is never left with none defaulted.
    if (method.isDefault) {
      const next = await tx.paymentMethod.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
      if (next) await tx.paymentMethod.update({ where: { id: next.id }, data: { isDefault: true } });
    }
  });

  return { ok: true, removedId: id };
}

export async function setDefaultPaymentMethod(userId: string, id: string) {
  const method = await prisma.paymentMethod.findUnique({ where: { id } });
  if (!method || method.userId !== userId) throw AppError.notFound('Payment method');

  await prisma.$transaction([
    prisma.paymentMethod.updateMany({ where: { userId }, data: { isDefault: false } }),
    prisma.paymentMethod.update({ where: { id }, data: { isDefault: true } }),
  ]);
  return { ok: true, defaultId: id };
}

/**
 * The channels an account may save, and what each needs. Served to the client so
 * the account form builds itself from one source of truth.
 */
export const SAVEABLE_CHANNELS = [
  { channel: PaymentChannel.CARD, label: 'Card (Visa / Mastercard / Amex)', requires: ['brand', 'last4'] },
  { channel: PaymentChannel.PAYPAL, label: 'PayPal', requires: ['payerId'] },
  { channel: PaymentChannel.CRYPTO_TRC20, label: 'USDT (TRC20)', requires: ['address'] },
] as const;
