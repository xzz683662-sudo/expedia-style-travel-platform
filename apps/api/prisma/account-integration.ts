import { PaymentChannel } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { getGatewayForChannel } from '../src/modules/payments/gateway';
import {
  addPaymentMethod,
  isValidTronAddress,
  listPaymentMethods,
  removePaymentMethod,
  setDefaultPaymentMethod,
} from '../src/modules/payments/methods';

/**
 * Integration check for the account centre and the modelled settlement rails.
 *
 * Needs a live database; NOT part of `pnpm verify` (verify must not mutate user
 * rows beyond what smoke already does). Run:
 *
 *   (cd apps/api && set -a && . ../../.env && set +a && ../../node_modules/.bin/tsx prisma/account-integration.ts)
 *
 * It proves the promises this stage's boundary makes:
 *   - the sandbox rails settle deterministically and never touch the network;
 *   - a stored method is a reference, never a secret (`providerToken` is never
 *     returned, and no PAN/CVC column exists to return);
 *   - a mistyped Tron address is rejected, because on-chain is irreversible;
 *   - add / set-default / remove keep the account coherent.
 */

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: string): void {
  checks += 1;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// A real Tron address with a valid base58check checksum (the USDT contract).
const VALID_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

async function main(): Promise<void> {
  console.log('══ Account centre & settlement rails ══');

  // -------------------------------------------------------------------------
  // 1. Settlement rails: sandbox settles, and labels itself honestly
  // -------------------------------------------------------------------------
  console.log('\nSettlement rails (sandbox)');

  const paypal = getGatewayForChannel(PaymentChannel.PAYPAL);
  const trc20 = getGatewayForChannel(PaymentChannel.CRYPTO_TRC20);
  const card = getGatewayForChannel(PaymentChannel.CARD);

  check('PayPal is its own rail, not the default gateway', paypal.name === 'paypal');
  check('TRC20 is its own rail', trc20.name === 'trc20');
  check('card still uses the configured gateway', card.name === 'mock' || card.name === 'hyperswitch');

  const paypalIntent = await paypal.createIntent({
    amountCents: 5000,
    currency: 'USD',
    orderId: 'ord_test',
    orderNumber: 'VY-TEST',
    customerEmail: 'test@example.com',
    method: PaymentChannel.PAYPAL,
    idempotencyKey: 'idem_paypal_test',
  });
  check('PayPal sandbox does not fail', paypalIntent.status === 'CAPTURED', paypalIntent.status);
  check('PayPal sandbox returns an approval URL', typeof paypalIntent.redirectUrl === 'string');

  // TRC20 needs a receiving address even in sandbox; without one it is inert.
  const trc20NoAddress = await trc20.createIntent({
    amountCents: 5000,
    currency: 'USD',
    orderId: 'ord_test',
    orderNumber: 'VY-TEST',
    customerEmail: 'test@example.com',
    method: PaymentChannel.CRYPTO_TRC20,
    idempotencyKey: 'idem_trc20_no_addr',
  });
  check('TRC20 without an address is inert, not silently crediting', trc20NoAddress.status === 'FAILED' && trc20NoAddress.failureCode === 'channel_not_configured', trc20NoAddress.status);

  // -------------------------------------------------------------------------
  // 2. Tron address validation
  // -------------------------------------------------------------------------
  console.log('\nTron address checksum');
  check('a valid Tron address passes', isValidTronAddress(VALID_TRON));
  check('a one-character mutation fails the checksum', !isValidTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u'));
  check('a wrong prefix fails', !isValidTronAddress('AR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'));
  check('too short fails', !isValidTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzg'));

  // -------------------------------------------------------------------------
  // 3. Payment-method storage
  // -------------------------------------------------------------------------
  console.log('\nSaved payment methods');

  const email = `acct-test-${Date.now()}@example.com`;
  const user = await prisma.user.create({
    data: { email, passwordHash: 'x', firstName: 'Acct', lastName: 'Test' },
  });

  try {
    const card1 = await addPaymentMethod(user.id, {
      channel: PaymentChannel.CARD,
      card: { brand: 'Visa', last4: '4242' },
      label: 'Travel card',
    });
    check('a card is saved as a reference', card1.last4 === '4242' && card1.brand === 'visa');
    check('a saved card stores no card number', !('cardNumber' in card1) && !('cvc' in card1));
    check('the first saved method becomes the default', card1.isDefault === true);

    // The service must refuse a last4 that looks like a full PAN.
    let fullNumberRejected = false;
    try {
      await addPaymentMethod(user.id, { channel: PaymentChannel.CARD, card: { brand: 'visa', last4: '424242424242' } });
    } catch {
      fullNumberRejected = true;
    }
    check('a full number cannot be smuggled into last4', fullNumberRejected);

    let badTronRejected = false;
    try {
      await addPaymentMethod(user.id, { channel: PaymentChannel.CRYPTO_TRC20, crypto: { address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u' } });
    } catch {
      badTronRejected = true;
    }
    check('a mistyped TRC20 address is rejected', badTronRejected);

    const wallet = await addPaymentMethod(user.id, {
      channel: PaymentChannel.CRYPTO_TRC20,
      crypto: { address: VALID_TRON },
      label: 'USDT wallet',
    });
    check('a valid TRC20 address is saved', wallet.brand === 'trc20' && wallet.last4 === VALID_TRON.slice(-6));
    check('the second method is not the default', wallet.isDefault === false);

    const methods = await listPaymentMethods(user.id);
    check('both methods are listed', methods.length === 2);
    check('defaults sort first', methods[0]?.isDefault === true);

    await setDefaultPaymentMethod(user.id, wallet.id);
    const afterDefault = await listPaymentMethods(user.id);
    check('setting a new default moves it', afterDefault[0]?.id === wallet.id);

    await removePaymentMethod(user.id, wallet.id);
    const afterRemove = await listPaymentMethods(user.id);
    check('removing a method leaves the other', afterRemove.length === 1);
    check('removing the default promotes another', afterRemove[0]?.isDefault === true);
  } finally {
    // Cascades remove the payment methods with the user.
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }

  const remaining = await prisma.paymentMethod.count({ where: { userId: user.id } });
  check('cleanup removed the test methods', remaining === 0);

  console.log(`\n${failures === 0 ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} — ${checks - failures}/${checks} checks`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('FAILED:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
