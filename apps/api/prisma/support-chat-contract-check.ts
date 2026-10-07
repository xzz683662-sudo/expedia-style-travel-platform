import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Offline contract gate for the support chat — `pnpm support-chat:contract`.
 *
 * No network and no database, matching `supply:contract` / `inventory:contract`.
 * What it protects is the one mistake in a chat feature that is expensive and
 * easy to make: **letting one shopper read another shopper's conversation**.
 *
 *   1. **Every customer read is scoped by `userId`**, taken from the token and
 *      never from the request body.
 *   2. **The staff perspective is explicit.** A load must say whether it is a
 *      customer or a staff read, so an unscoped query cannot be reached by
 *      accident.
 *   3. **Realtime fan-out is topic-based**, not client-selected: the bus grants
 *      `user:<id>` and `role:<ROLE>`, and the chat module addresses events to
 *      those topics rather than to a socket list.
 *   4. **Both staff roles are covered** and neither MERCHANT nor OPERATOR (which
 *      no longer exist) can reach the inbox.
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

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

console.log('══ Support chat contract ══');

const chat = stripComments(source('modules/support/chat.ts'));
const routes = stripComments(source('routes/chat.routes.ts'));
const bus = stripComments(source('modules/realtime/bus.ts'));
const schema = readFileSync(resolve(ROOT, 'prisma/schema.prisma'), 'utf8');

// ---------------------------------------------------------------------------
// 1. Customer reads are scoped by the token's user
// ---------------------------------------------------------------------------
console.log('\nAuthorization (a shopper only ever sees their own thread)');

check('the customer list filter is `userId`', /listConversationsForCustomer\(userId: string\)/.test(chat));
check('the customer list queries `where: { userId }`', /findMany\(\{\s*where:\s*\{\s*userId\s*\}/.test(chat));
check('the scoped load filters by userId for a customer', /as\.kind === 'customer' \? \{ userId: (input\.)?as\.userId \}/.test(chat));
check('the perspective is a required argument', /as:\s*\{ kind: 'customer'; userId: string \} \| \{ kind: 'staff' \}/.test(chat));
check('posting a message proves ownership first', /where:\s*\{ id,\s*userId:\s*user\.id \}/.test(routes));
check('an attached order must belong to the caller', /where:\s*\{ id:\s*body\.orderId,\s*userId:\s*user\.id \}/.test(routes));
check('the customer routes never accept a userId from the body', !/body\.userId/.test(routes));

// ---------------------------------------------------------------------------
// 2. Staff surface
// ---------------------------------------------------------------------------
console.log('\nStaff surface');

check('the inbox is gated to SUPPORT and ADMIN', /requireRole\('SUPPORT', 'ADMIN'\)/.test(routes));
check('the inbox is not scoped by user', /listInbox\(/.test(chat) && !/export async function listInbox[\s\S]{0,200}userId:\s*string/.test(chat.split('export async function listInbox')[1] ?? ''));
check('the retired roles are gone from the realtime staff set', !/OPERATOR|MERCHANT/.test(bus));
check('STAFF_ROLES is exactly ADMIN + SUPPORT', /STAFF_ROLES = \['ADMIN', 'SUPPORT'\]/.test(bus));

// ---------------------------------------------------------------------------
// 3. Realtime addressing
// ---------------------------------------------------------------------------
console.log('\nRealtime');

check('chat events are addressed by user and staff role', /audience:\s*\{\s*userId:\s*input\.userId,\s*roles:\s*STAFF_ROLES\s*\}/.test(chat));
check('the module publishes through the shared bus', /publishEvent\(/.test(chat) && /from '\.\.\/realtime\/bus'/.test(chat));
check('unread is maintained on write, not aggregated at read', /staffUnread:\s*\{\s*increment:\s*1\s*\}/.test(chat) && /customerUnread:\s*\{\s*increment:\s*1\s*\}/.test(chat));

// ---------------------------------------------------------------------------
// 4. Durability
// ---------------------------------------------------------------------------
console.log('\nDurability (realtime pushes, Postgres records)');

check('SupportConversation exists', /model SupportConversation \{/.test(schema));
check('SupportMessage exists', /model SupportMessage \{/.test(schema));
check('a message is always persisted', /prisma\.supportMessage\.create\(/.test(chat));
check('closing a conversation clears the shopper badge', /CLOSED \? \{ customerUnread: 0 \}/.test(chat));
check('a customer reply reopens a closed thread', /fromCustomer \? \{ status: SupportConversationStatus\.OPEN/.test(chat));

console.log(`\n${failures === 0 ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m — ${checks - failures}/${checks} checks`);
process.exitCode = failures === 0 ? 0 : 1;
