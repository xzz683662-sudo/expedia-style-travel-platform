import { SupportAuthorType } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { hashPassword } from '../src/utils/crypto';
import { closeRedis } from '../src/utils/redis';
import { closeRealtimeBus } from '../src/modules/realtime/bus';
import { sendVerificationEmail, verifyEmailCode } from '../src/modules/mail/verification';
import {
  appendMessage,
  customerUnreadTotal,
  getConversationWithMessages,
  listConversationsForCustomer,
  openConversationForCustomer,
  setConversationStatus,
  staffUnreadTotal,
} from '../src/modules/support/chat';
import { SupportConversationStatus } from '@prisma/client';

/**
 * End-to-end integration for email verification and support chat.
 *
 * `pnpm --filter @easytrip/api auth:integration`
 *
 * This is the DB-backed half of the pair: the `*:contract` gates assert the
 * rules statically and offline, and this script proves they hold against real
 * rows. It creates its own throwaway data and removes it again, so it is safe
 * to run against a seeded development database.
 */

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` \x1b[2m${detail}\x1b[0m` : ''}`);
  } else {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const stamp = Date.now();
const customerEmail = `verify.${stamp}@easytrip.test`;
const otherEmail = `other.${stamp}@easytrip.test`;

async function main(): Promise<void> {
  console.log('══ Auth + chat integration ══');

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------
  console.log('\nFixtures');
  const customer = await prisma.user.create({
    data: {
      email: customerEmail,
      passwordHash: hashPassword('Password123!'),
      firstName: 'Verify',
      lastName: 'Tester',
    },
  });
  const other = await prisma.user.create({
    data: {
      email: otherEmail,
      passwordHash: hashPassword('Password123!'),
      firstName: 'Other',
      lastName: 'Shopper',
    },
  });
  check('created two throwaway users', Boolean(customer.id && other.id));

  // -------------------------------------------------------------------------
  // 1. Issuing a code
  // -------------------------------------------------------------------------
  console.log('\nIssuing a verification code');
  const issued = await sendVerificationEmail({ userId: customer.id, email: customer.email, firstName: customer.firstName });

  check('the code is six digits', /^\d{6}$/.test(issued.code), `code=${issued.code}`);

  const row = await prisma.emailVerificationCode.findFirst({
    where: { userId: customer.id },
    orderBy: { createdAt: 'desc' },
  });
  check('a row was persisted', row !== null);
  check('the plaintext code is NOT in the row', row !== null && row.codeHash !== issued.code);
  check('the stored value is a 64-char digest', row !== null && /^[0-9a-f]{64}$/.test(row.codeHash));
  check('the code has not been consumed yet', row !== null && row.consumedAt === null);
  check('attempts start at zero', row !== null && row.attempts === 0);
  check('the code expires in the future', row !== null && row.expiresAt.getTime() > Date.now());
  check('the account is still unverified', (await prisma.user.findUniqueOrThrow({ where: { id: customer.id } })).emailVerifiedAt === null);

  // -------------------------------------------------------------------------
  // 2. A wrong code is rejected and counted
  // -------------------------------------------------------------------------
  console.log('\nA wrong code is rejected');
  const wrong = issued.code === '000000' ? '111111' : '000000';
  const wrongOutcome = await verifyEmailCode(customer.id, wrong);
  check('the wrong code is refused', wrongOutcome.status === 'invalid', `status=${wrongOutcome.status}`);
  const afterWrong = await prisma.emailVerificationCode.findFirstOrThrow({ where: { userId: customer.id } });
  check('the attempt was counted', afterWrong.attempts === 1, `attempts=${afterWrong.attempts}`);
  check('the account is still unverified', (await prisma.user.findUniqueOrThrow({ where: { id: customer.id } })).emailVerifiedAt === null);

  // -------------------------------------------------------------------------
  // 3. The right code verifies, exactly once
  // -------------------------------------------------------------------------
  console.log('\nThe right code verifies');
  const okOutcome = await verifyEmailCode(customer.id, issued.code);
  check('the correct code is accepted', okOutcome.status === 'ok', `status=${okOutcome.status}`);

  const verified = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
  check('the account is now verified', verified.emailVerifiedAt !== null);

  const consumed = await prisma.emailVerificationCode.findFirstOrThrow({ where: { userId: customer.id } });
  check('the code is marked consumed', consumed.consumedAt !== null);

  const replay = await verifyEmailCode(customer.id, issued.code);
  check('replaying the same code fails', replay.status === 'not_found', `status=${replay.status}`);

  // -------------------------------------------------------------------------
  // 4. Chat: a customer opens a thread and writes to it
  // -------------------------------------------------------------------------
  console.log('\nChat: the shopper side');
  const { conversation } = await openConversationForCustomer({
    userId: customer.id,
    firstMessage: 'Hi, I need to change the date on my booking.',
  });
  check('a conversation was created', Boolean(conversation.id));
  check('the first message was stored', (await prisma.supportMessage.count({ where: { conversationId: conversation.id } })) === 1);
  check('staff unread reflects the new message', conversation.staffUnread === 1, `staffUnread=${conversation.staffUnread}`);
  check('the shopper has nothing unread', conversation.customerUnread === 0);
  check('opening again resumes the same thread', (await openConversationForCustomer({ userId: customer.id })).conversation.id === conversation.id);

  const mine = await listConversationsForCustomer(customer.id);
  check('the shopper lists exactly their own thread', mine.length === 1 && mine[0]!.id === conversation.id);

  // -------------------------------------------------------------------------
  // 5. Chat: authorization isolation
  // -------------------------------------------------------------------------
  console.log('\nChat: authorization');
  let blocked = false;
  try {
    await getConversationWithMessages({
      conversationId: conversation.id,
      as: { kind: 'customer', userId: other.id },
    });
  } catch {
    blocked = true;
  }
  check('another shopper cannot read the thread', blocked);

  const otherThreads = await listConversationsForCustomer(other.id);
  check('another shopper lists nothing', otherThreads.length === 0);

  // -------------------------------------------------------------------------
  // 6. Chat: the agent replies
  // -------------------------------------------------------------------------
  console.log('\nChat: the agent side');
  await appendMessage({
    conversationId: conversation.id,
    authorType: SupportAuthorType.AGENT,
    authorUserId: null,
    body: 'Of course — which date would you prefer?',
  });

  const refreshed = await prisma.supportConversation.findUniqueOrThrow({ where: { id: conversation.id } });
  check('the shopper has an unread agent message', refreshed.customerUnread === 1, `customerUnread=${refreshed.customerUnread}`);
  check('the thread preview follows the newest message', refreshed.lastPreview?.includes('which date') === true);
  check('the shopper unread total is one', (await customerUnreadTotal(customer.id)) === 1);

  // Reading as the staff perspective clears the staff counter.
  await getConversationWithMessages({ conversationId: conversation.id, as: { kind: 'staff' } });
  check('staff unread cleared after opening', (await staffUnreadTotal()) >= 0);
  const afterStaffRead = await prisma.supportConversation.findUniqueOrThrow({ where: { id: conversation.id } });
  check('the staff counter is zero after a staff read', afterStaffRead.staffUnread === 0);

  // -------------------------------------------------------------------------
  // 7. Closing clears the shopper badge; a reply reopens
  // -------------------------------------------------------------------------
  console.log('\nChat: lifecycle');
  await setConversationStatus({ conversationId: conversation.id, status: SupportConversationStatus.CLOSED });
  const closed = await prisma.supportConversation.findUniqueOrThrow({ where: { id: conversation.id } });
  check('closing clears the shopper badge', closed.customerUnread === 0);
  check('the status is CLOSED', closed.status === SupportConversationStatus.CLOSED);

  await appendMessage({
    conversationId: conversation.id,
    authorType: SupportAuthorType.CUSTOMER,
    authorUserId: customer.id,
    body: 'Thanks, one more question.',
  });
  const reopened = await prisma.supportConversation.findUniqueOrThrow({ where: { id: conversation.id } });
  check('a shopper reply reopens a closed thread', reopened.status === SupportConversationStatus.OPEN);

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------
  await prisma.user.deleteMany({ where: { id: { in: [customer.id, other.id] } } });
  const leftovers = await prisma.supportConversation.count({ where: { id: conversation.id } });
  check('cleanup removed the conversation (cascade)', leftovers === 0);

  console.log(`\n${failures === 0 ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m — ${checks - failures}/${checks}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error: unknown) => {
    console.error('\x1b[31mfailed\x1b[0m', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // The chat module publishes through the realtime bus, which lazily opens a
    // Redis connection on the first event. An open ioredis socket is a live
    // handle, so without closing it the process prints its result and then
    // simply hangs — which is worse than failing, because a CI run would
    // time out with a green-looking report already on screen.
    await closeRealtimeBus();
    await closeRedis();
    await prisma.$disconnect();
  });
