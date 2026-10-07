import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CREDENTIAL_ORDER,
  readableSources,
  SOURCE_CREDENTIALS,
  STAGE_BOUNDARY,
  transactionCapableSources,
} from '../src/modules/supply/credentials';

/**
 * Offline contract gate for the credential audit — `pnpm credentials:contract`.
 *
 * The mandate is explicit: data-access credentials and transaction credentials
 * must be audited separately and never conflated, and this stage is bounded to
 * read-only use of the first three classes. Those are *claims*; this gate turns
 * them into assertions that run on a fresh clone with no network and no key.
 *
 * What it pins:
 *   1. every known source is classified, and the classification is coherent;
 *   2. **no source with an enabled credential can book or settle** in this stage;
 *   3. the settlement adapters refuse `live` rather than merely lacking config;
 *   4. the payment-method surface can never store a card secret.
 */

const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'src');

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail?: string): void {
  checks += 1;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

console.log('══ Credential classification contract ══');

// ---------------------------------------------------------------------------
// 1. Classification coverage and coherence
// ---------------------------------------------------------------------------
console.log('\nClassification');

check('there is at least one classified source', SOURCE_CREDENTIALS.length > 0, `${SOURCE_CREDENTIALS.length} sources`);

const ids = SOURCE_CREDENTIALS.map((s) => s.id);
check('source ids are unique', new Set(ids).size === ids.length);

const unknownKind = SOURCE_CREDENTIALS.find((s) => s.kinds.some((k) => !CREDENTIAL_ORDER.includes(k)));
check('every kind is a known class', unknownKind === undefined, unknownKind?.id);

const noKinds = SOURCE_CREDENTIALS.find((s) => s.kinds.length === 0);
check('every source declares at least one kind', noKinds === undefined, noKinds?.id);

/**
 * `canBook` / `canSettle` describe the *enabled* capability, while `kinds`
 * describes what the credential class authorises. So the implication runs one
 * way only: a source that can book must be classed BOOKING (or SETTLEMENT). The
 * converse is not required — `cruise` is classed BOOKING to record what a real
 * integration would need while its `canBook` is false precisely because this
 * stage has not enabled it. That gap is the point of the audit.
 */
const lying = SOURCE_CREDENTIALS.find((s) => s.canBook && !s.kinds.includes('BOOKING') && !s.kinds.includes('SETTLEMENT'));
check('a source that can book is classed BOOKING/SETTLEMENT', lying === undefined, lying?.id);
const lyingSettle = SOURCE_CREDENTIALS.find((s) => s.canSettle && !s.kinds.includes('SETTLEMENT'));
check('a source that can settle is classed SETTLEMENT', lyingSettle === undefined, lyingSettle?.id);

// ---------------------------------------------------------------------------
// 2. The stage boundary: no ENABLED transaction credential
// ---------------------------------------------------------------------------
console.log('\nStage boundary (read-only supply)');

check('boundary admits only PUBLIC / API_KEY / SUPPLIER', STAGE_BOUNDARY.allowedKinds.every((k) => ['PUBLIC', 'API_KEY', 'SUPPLIER'].includes(k)));
check('boundary forbids booking and settlement', STAGE_BOUNDARY.forbiddenCapabilities.includes('canBook') && STAGE_BOUNDARY.forbiddenCapabilities.includes('canSettle'));
check('supplier use is READ_ONLY', STAGE_BOUNDARY.supplierUse === 'READ_ONLY');

const enabledTransactors = transactionCapableSources().filter((s) => s.available);
check(
  'no enabled source can book or settle',
  enabledTransactors.length === 0,
  enabledTransactors.map((s) => s.id).join(', ') || undefined,
);

// Every transaction-capable source must be explicitly unavailable, so "we
// documented it" stays distinguishable from "we turned it on".
const unmarked = transactionCapableSources().filter((s) => s.available);
check('every transaction-capable source is marked unavailable', unmarked.length === 0);

// Readable sources (the ones this stage may actually use) must be non-transacting.
const readable = readableSources();
check('readable sources are all non-transacting', readable.every((s) => !s.canBook && !s.canSettle), `${readable.length} readable`);

// ---------------------------------------------------------------------------
// 3. Settlement adapters refuse live
// ---------------------------------------------------------------------------
console.log('\nSettlement rails refuse live settlement');

const gateway = stripComments(read('modules/payments/gateway.ts'));
// The guard function is `liveRailRefused`; the *failure code* it returns is the
// string `live_rail_out_of_scope`. Assert on the call, which is what proves the
// class actually routes through the refusal.
check('a live refusal exists', gateway.includes('function liveRailRefused'));
check('PayPal refuses live', /class PayPalPaymentGateway[\s\S]*?liveRailRefused\(/.test(gateway));
check('TRC20 refuses live', /class Trc20PaymentGateway[\s\S]*?liveRailRefused\(/.test(gateway));
check('gateway selection is channel-aware', gateway.includes('getGatewayForChannel'));

// ---------------------------------------------------------------------------
// 4. No card secrets may ever be stored
// ---------------------------------------------------------------------------
console.log('\nNo card secrets at rest');

const methods = stripComments(read('modules/payments/methods.ts'));
const schema = readFileSync(resolve(ROOT, 'prisma/schema.prisma'), 'utf8');

// The Prisma model must not grow a PAN/CVC column.
const paymentMethodModel = /model PaymentMethod \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? '';
check('PaymentMethod model found', paymentMethodModel.length > 0);
check('PaymentMethod has no card-number column', !/\bnumber\b\s+String/.test(paymentMethodModel));
check('PaymentMethod has no cvc column', !/\bcvc\b\s+String/.test(paymentMethodModel));
check('PaymentMethod has a token reference, not a secret', paymentMethodModel.includes('providerToken'));

// The service must reject a full number rather than accept one.
check('the method service validates last4 is four digits', methods.includes('four digits'));
check('the method service validates Tron addresses', methods.includes('isValidTronAddress'));
check('payment methods are SETTLEMENT-classed', methods.includes('CredentialClass.SETTLEMENT'));

// The customer-facing API must not accept a PAN in its schema, and must not
// return the settlement token to the browser.
const account = stripComments(read('routes/account.routes.ts'));
check('the account API accepts no PAN field', !/number:\s*z\.string\(\)\.min\(12\)/.test(account));
const publicMapper = /function toPublicMethod[\s\S]*?\n\}/.exec(account)?.[0] ?? '';
check('toPublicMethod is present', publicMapper.length > 0);
check('toPublicMethod omits providerToken', publicMapper.length > 0 && !publicMapper.includes('providerToken'));

// ---------------------------------------------------------------------------
// 5. Audit is reachable and documented
// ---------------------------------------------------------------------------
console.log('\nAudit reachability');

const index = stripComments(read('index.ts'));
check('the account surface is registered', index.includes('accountRoutes'));
check('the credential registry is importable from routes', account.includes('credentials'));

console.log(`\n${failures === 0 ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} — ${checks - failures}/${checks} checks`);
if (failures > 0) process.exitCode = 1;
