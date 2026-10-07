import { randomInt, timingSafeEqual } from 'crypto';
import { config } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { sha256 } from '../../utils/crypto';
import { sendMail } from './transport';

/**
 * ---------------------------------------------------------------------------
 * Email address verification
 * ---------------------------------------------------------------------------
 *
 * Registration issues a short numeric code; the shopper types it back. The
 * design mirrors password storage rather than inventing a second pattern:
 *
 *   - **Only a hash is stored.** A leaked database must not hand an attacker a
 *     working code for every account. `sha256` is enough here because the code
 *     is short-lived and attempt-limited — an offline brute force of a six-digit
 *     space is irrelevant when the code is dead 15 minutes after issue and the
 *     online path caps wrong guesses.
 *   - **Single use.** Accepting a code stamps `consumedAt`; a replay matches
 *     zero rows rather than needing a special case.
 *   - **Attempt-limited.** Wrong guesses are counted on the row, so a shopper
 *     cannot walk the six-digit space within the TTL.
 *   - **Newest wins.** Issuing a code retires any earlier unconsumed one, so an
 *     old email in the inbox cannot still be used.
 */

export const VERIFY_CODE_LENGTH = 6;

function generateCode(): string {
  // Uniform over [0, 1_000_000) then zero-padded, so "000123" is a valid code
  // and the space is exactly 10^6 rather than 9·10^5.
  return String(randomInt(0, 10 ** VERIFY_CODE_LENGTH)).padStart(VERIFY_CODE_LENGTH, '0');
}

function codeMatches(candidate: string, storedHash: string): boolean {
  const left = Buffer.from(sha256(candidate), 'hex');
  const right = Buffer.from(storedHash, 'hex');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Issues a fresh code, retiring any earlier unconsumed one. Returns the plaintext. */
export async function issueEmailVerificationCode(userId: string): Promise<{ code: string; expiresAt: Date }> {
  await prisma.emailVerificationCode.updateMany({
    where: { userId, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  const code = generateCode();
  const expiresAt = new Date(Date.now() + config.mail.codeTtlMinutes * 60_000);

  await prisma.emailVerificationCode.create({
    data: { userId, codeHash: sha256(code), expiresAt },
  });

  return { code, expiresAt };
}

/** Composes and sends the verification email. Throws if the transport fails. */
export async function sendVerificationEmail(input: {
  userId: string;
  email: string;
  firstName?: string;
  locale?: string;
}): Promise<{ code: string; expiresAt: Date }> {
  const { code, expiresAt } = await issueEmailVerificationCode(input.userId);

  const minutes = config.mail.codeTtlMinutes;
  const zh = (input.locale ?? '').startsWith('zh');
  const greeting = input.firstName ? (zh ? `${input.firstName}，您好：` : `Hi ${input.firstName},`) : '';

  const subject = zh ? '验证您的邮箱地址 — 易捷旅行' : 'Verify your email address — EasyTrip';
  const text = zh
    ? `${greeting}\n\n您的验证码是：${code}\n\n该验证码将在 ${minutes} 分钟后失效。如果这不是您本人的操作，请忽略本邮件。`
    : `${greeting}\n\nYour verification code is: ${code}\n\nIt expires in ${minutes} minutes. If you did not request this, you can ignore this email.`;

  await sendMail({ to: input.email, subject, text });

  logger.info('mail.verification_sent', { userId: input.userId, expiresAt: expiresAt.toISOString() });
  return { code, expiresAt };
}

export type VerifyOutcome =
  | { status: 'ok' }
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'too_many_attempts' }
  | { status: 'not_found' };

/**
 * Checks a code for a user and, on success, marks the email verified.
 *
 * Returns a discriminated result instead of throwing so the route owns the
 * error shape — and, more importantly, so every failure mode can be collapsed
 * into one message there. Distinguishing "expired" from "invalid" for the client
 * would help an attacker, not the shopper.
 */
export async function verifyEmailCode(userId: string, code: string): Promise<VerifyOutcome> {
  const row = await prisma.emailVerificationCode.findFirst({
    where: { userId, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (!row) return { status: 'not_found' };

  if (row.expiresAt.getTime() < Date.now()) {
    return { status: 'expired' };
  }

  if (row.attempts >= config.mail.maxAttempts) {
    return { status: 'too_many_attempts' };
  }

  if (!codeMatches(code, row.codeHash)) {
    // Burn an attempt. A lost update here would only make the limit slightly
    // looser under a race, never looser than 2× — acceptable for this control.
    await prisma.emailVerificationCode.update({
      where: { id: row.id },
      data: { attempts: { increment: 1 } },
    });
    return { status: 'invalid' };
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.emailVerificationCode.update({ where: { id: row.id }, data: { consumedAt: now } }),
    prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: now } }),
  ]);

  logger.info('mail.verification_confirmed', { userId });
  return { status: 'ok' };
}

/** True when the account has confirmed its address. */
export async function isEmailVerified(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { emailVerifiedAt: true },
  });
  return Boolean(user?.emailVerifiedAt);
}
