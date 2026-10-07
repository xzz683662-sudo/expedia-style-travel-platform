import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sha256 } from '../src/utils/crypto';

/**
 * Offline contract gate for email verification — `pnpm auth:contract`.
 *
 * No network and no database, like `supply:contract` and `inventory:contract`.
 * The point is to make the rules that keep a verification code *safe* into
 * something that fails the build rather than something a reviewer has to
 * remember:
 *
 *   1. **Never store the code.** Only a hash may reach the database. A plaintext
 *      column would turn a read-only leak into account takeover for every
 *      pending registration.
 *   2. **Single use, and time-boxed.** Accepting a code consumes it and stamps
 *      the user, in one transaction.
 *   3. **Attempts are capped.** Wrong guesses increment a counter.
 *   4. **One failure message.** The API must not tell a caller whether a code
 *      was expired versus simply wrong, or whether the address exists.
 *   5. **The dev-only code echo can never reach production.**
 *   6. **Checkout is gated** for a signed-in account whose email is unconfirmed.
 */

const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'src');

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function source(relPath: string): string {
  return readFileSync(resolve(SRC, relPath), 'utf8');
}

/** Strips comments so the guard does not fire on its own explanation. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

console.log('══ Email verification contract ══');

const schema = readFileSync(resolve(ROOT, 'prisma/schema.prisma'), 'utf8');
const verification = stripComments(source('modules/mail/verification.ts'));
const transport = stripComments(source('modules/mail/transport.ts'));
const authRoutes = stripComments(source('routes/auth.routes.ts'));
const orderRoutes = stripComments(source('routes/orders.routes.ts'));
const env = readFileSync(resolve(SRC, 'config/env.ts'), 'utf8');
const errors = stripComments(source('utils/errors.ts'));

// ---------------------------------------------------------------------------
// 1. Storage shape
// ---------------------------------------------------------------------------
console.log('\nStorage (a code is never persisted in the clear)');

const model = schema.match(/model EmailVerificationCode \{[\s\S]*?\n\}/)?.[0] ?? '';
check('EmailVerificationCode model exists', model.length > 0);
check('it stores a hash, not a code', /codeHash\s+String/.test(model) && !/\bcode\s+String/.test(model));
check('it records an expiry', /expiresAt\s+DateTime/.test(model));
check('it records consumption', /consumedAt\s+DateTime\?/.test(model));
check('it counts attempts', /attempts\s+Int/.test(model));

// ---------------------------------------------------------------------------
// 2. Hashing and comparison
// ---------------------------------------------------------------------------
console.log('\nHashing');

check('the stored value is a sha256 of the code', /codeHash:\s*sha256\(code\)/.test(verification));
check('only a hash reaches the create call', !/data:\s*\{[^}]*\bcode:\s*code\b/.test(verification));
check('comparison is constant-time', /timingSafeEqual\(/.test(verification));
check('a length mismatch is rejected before comparing', /left\.length\s*!==\s*right\.length/.test(verification));

// A cheap runtime sanity check that the digest is the size the column expects.
const digest = sha256('000123');
check('sha256 is 64 hex chars', /^[0-9a-f]{64}$/.test(digest));
check('different codes hash differently', sha256('000123') !== sha256('000124'));

// ---------------------------------------------------------------------------
// 3. Lifecycle
// ---------------------------------------------------------------------------
console.log('\nLifecycle (single use, capped, newest wins)');

check('accepting consumes the code and verifies the user in one transaction', /\$transaction\(\[/.test(verification));
check('acceptance stamps consumedAt', /consumedAt:\s*now/.test(verification));
check('acceptance stamps emailVerifiedAt', /emailVerifiedAt:\s*now/.test(verification));
check('a wrong code increments attempts', /attempts:\s*\{\s*increment:\s*1\s*\}/.test(verification));
check('a new code retires the previous unconsumed one', /updateMany\(/.test(verification) && /consumedAt:\s*new Date\(\)/.test(verification));

// ---------------------------------------------------------------------------
// 4. Non-enumeration and one failure message
// ---------------------------------------------------------------------------
console.log('\nNon-enumeration');

const failureMessages = authRoutes.match(/AppError\.validation\('That code is not valid or has expired'\)/g) ?? [];
check('verify-email answers one generic message', failureMessages.length >= 1);
check('no distinct "expired" message is exposed', !/'[^']*expired[^']*'\s*\)/.test(authRoutes.replace(/That code is not valid or has expired/g, '')));
check('resend answers `sent: true` even for an unknown address', /if\s*\(!user\s*\|\|\s*user\.emailVerifiedAt\)\s*\{\s*return\s*\{\s*sent:\s*true/.test(authRoutes));
check('resend is cooldown-limited', /RATE_LIMITED/.test(authRoutes) && /resendCooldownSeconds/.test(authRoutes));

// ---------------------------------------------------------------------------
// 5. The development echo is production-proof
// ---------------------------------------------------------------------------
console.log('\nDevelopment code echo');

check('exposeDevCode is false in production regardless of transport', /!==\s*'production'/.test(env));
check('the code is only echoed when exposeDevCode is true', /if\s*\(config\.mail\.exposeDevCode\)/.test(authRoutes));
check('the default transport is the console (zero keys)', /transport:\s*str\('MAIL_TRANSPORT',\s*'console'\)/.test(env));
check('resend without a key degrades instead of throwing', /mail\.resend_missing_key/.test(transport));

// ---------------------------------------------------------------------------
// 6. Checkout gate
// ---------------------------------------------------------------------------
console.log('\nCheckout gate');

check('EMAIL_NOT_VERIFIED is a first-class error code', /'EMAIL_NOT_VERIFIED'/.test(errors));
check('the orders route checks verification for a signed-in user', /await isEmailVerified\(user\.id\)/.test(orderRoutes));
check('a guest is not blocked by the gate', /if\s*\(user\s*&&\s*!\(await isEmailVerified/.test(orderRoutes));

console.log(`\n${failures === 0 ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m — ${checks - failures}/${checks} checks`);
process.exitCode = failures === 0 ? 0 : 1;
