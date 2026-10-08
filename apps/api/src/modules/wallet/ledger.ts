import { WalletTransactionKind } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../utils/errors';

/**
 * ---------------------------------------------------------------------------
 * Stored-value ledger
 * ---------------------------------------------------------------------------
 *
 * The single place a balance changes. `User.walletCents` is a cached running
 * total for O(1) reads; every movement also appends a `WalletTransaction`, and
 * this function is what keeps the two consistent — a balance written without a
 * ledger row is unexplainable, and a ledger row without a balance write is
 * money the shopper cannot spend.
 *
 * The money rules live here rather than at each call site:
 *
 *   1. **A balance may not go negative.** A negative balance reads as "the
 *      shopper owes us", which the storefront has no way to explain or settle.
 *      Refuse the movement instead of clamping it.
 *   2. **The write is one transaction.** Balance and ledger entry commit
 *      together or not at all.
 *   3. **Amounts are signed minor units.** Positive credits, negative debits —
 *      the same convention `SupportCustomers` and the refund path already use.
 *
 * Note there is deliberately no "top-up via the payment gateway" path: the
 * `Payment` model is order-scoped (`Payment.orderId` is required), so a
 * standalone charge has nowhere to live. The ledger entry is the record of a
 * top-up; attaching a card charge to it is a payments-rail integration, not a
 * wallet concern.
 */

export type WalletEntryInput = {
  userId: string;
  /** Signed minor units. Positive credits the shopper, negative debits them. */
  amountCents: number;
  kind: WalletTransactionKind;
  /** Human-readable reason. Rendered in the statement, so it must read well. */
  note: string;
  currency?: string;
  orderId?: string | null;
  /** Who caused it. Null means the platform did. */
  actorId?: string | null;
  actorEmail?: string | null;
};

export type WalletEntryResult = {
  balanceCents: number;
  transactionId: string;
};

export async function postWalletEntry(input: WalletEntryInput): Promise<WalletEntryResult> {
  // A zero movement is always a caller bug: it would append noise to the
  // statement and change nothing. `=== 0` is a valid *value* here (unlike a
  // refund, where zero is a real outcome), so it is rejected outright.
  if (!Number.isInteger(input.amountCents) || input.amountCents === 0) {
    throw AppError.badRequest('Amount must be a non-zero integer in minor units');
  }
  if (!input.note.trim()) {
    throw AppError.badRequest('A wallet entry needs a note so the statement can explain itself');
  }

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, walletCents: true },
  });
  if (!user) throw AppError.notFound('Account');

  const nextBalance = user.walletCents + input.amountCents;
  if (nextBalance < 0) {
    throw AppError.badRequest(
      `Insufficient balance: ${user.walletCents} available, ${Math.abs(input.amountCents)} requested`,
    );
  }

  return prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: input.userId },
      // Spending the balance is what `walletEnabled` gates, so any movement
      // makes it spendable — otherwise a top-up would land in a frozen balance.
      data: { walletCents: nextBalance, walletEnabled: true },
    });

    const entry = await tx.walletTransaction.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        amountCents: input.amountCents,
        currency: input.currency ?? 'USD',
        balanceAfterCents: nextBalance,
        orderId: input.orderId ?? null,
        note: input.note,
        actorId: input.actorId ?? null,
        actorEmail: input.actorEmail ?? null,
      },
    });

    return { balanceCents: nextBalance, transactionId: entry.id };
  });
}

/** The shopper's statement, newest first. */
export async function listWalletEntries(userId: string, take = 25) {
  return prisma.walletTransaction.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      kind: true,
      amountCents: true,
      currency: true,
      balanceAfterCents: true,
      note: true,
      orderId: true,
      createdAt: true,
    },
  });
}
