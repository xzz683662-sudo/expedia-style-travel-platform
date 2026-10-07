import { SupportAuthorType, SupportConversationStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../utils/errors';
import { STAFF_ROLES, publishEvent } from '../realtime/bus';

/**
 * ---------------------------------------------------------------------------
 * Support chat
 * ---------------------------------------------------------------------------
 *
 * A durable 1:1 thread between a signed-in shopper and the support console.
 *
 * Two properties worth stating, because both are load-bearing:
 *
 *  1. **Every message is a row.** The WebSocket only *pushes*; the widget and
 *     the inbox both rehydrate from Postgres, so a reload and a second device
 *     see the same history. Realtime is never the record.
 *  2. **Unread counts live on the conversation, not in an aggregate.** The
 *     badge on the storefront bubble and the queue counter in the console are
 *     both a single indexed read rather than a `COUNT(*)` over messages.
 *
 * Authorization is enforced here rather than in the routes so it cannot be
 * forgotten at a call site: a customer query is *always* scoped by `userId`,
 * and the staff queries never return another tenant's rows.
 */

const MESSAGE_PREVIEW_CHARS = 140;

export type ShapedSupportMessage = {
  id: string;
  conversationId: string;
  authorType: string;
  authorName: string | null;
  body: string;
  createdAt: string;
  readAt: string | null;
};

export type ShapedConversation = {
  id: string;
  subject: string;
  status: string;
  orderId: string | null;
  assignedToUserId: string | null;
  customerUnread: number;
  staffUnread: number;
  lastMessageAt: string;
  lastPreview: string | null;
  createdAt: string;
  /** Staff view only: who is asking. */
  customer?: { id: string; name: string; email: string } | null;
};

type MessageRow = {
  id: string;
  conversationId: string;
  authorType: string;
  authorUserId: string | null;
  body: string;
  createdAt: Date;
  readAt: Date | null;
  author?: { firstName: string; lastName: string } | null;
};

export function shapeSupportMessage(row: MessageRow): ShapedSupportMessage {
  const name = row.author
    ? `${row.author.firstName} ${row.author.lastName}`.trim()
    : authorFallbackName(row.authorType);
  return {
    id: row.id,
    conversationId: row.conversationId,
    authorType: row.authorType,
    // A SYSTEM line has no person behind it; keep the label explicit rather
    // than letting the client guess from a null.
    authorName: name,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt ? row.readAt.toISOString() : null,
  };
}

function authorFallbackName(authorType: string): string | null {
  if (authorType === 'SYSTEM') return 'EasyTrip';
  if (authorType === 'AGENT') return 'Support';
  return null;
}

type ConversationRow = {
  id: string;
  subject: string;
  status: string;
  orderId: string | null;
  assignedToUserId: string | null;
  customerUnread: number;
  staffUnread: number;
  lastMessageAt: Date;
  lastPreview: string | null;
  createdAt: Date;
  user?: { id: string; firstName: string; lastName: string; email: string } | null;
};

export function shapeConversation(row: ConversationRow, options?: { includeCustomer?: boolean }): ShapedConversation {
  const shaped: ShapedConversation = {
    id: row.id,
    subject: row.subject,
    status: row.status,
    orderId: row.orderId,
    assignedToUserId: row.assignedToUserId,
    customerUnread: row.customerUnread,
    staffUnread: row.staffUnread,
    lastMessageAt: row.lastMessageAt.toISOString(),
    lastPreview: row.lastPreview,
    createdAt: row.createdAt.toISOString(),
  };
  if (options?.includeCustomer) {
    shaped.customer = row.user
      ? {
          id: row.user.id,
          name: `${row.user.firstName} ${row.user.lastName}`.trim(),
          email: row.user.email,
        }
      : null;
  }
  return shaped;
}

/**
 * Publishes a chat event.
 *
 * Addressed to the shopper *and* every staff role on purpose: the shopper's
 * bubble and the console inbox are two views of one fact, and a mismatch
 * between them is a support ticket about the support tool.
 */
function emitConversationEvent(input: {
  type: 'support.message' | 'support.conversation';
  conversationId: string;
  userId: string;
  customerUnread: number;
  staffUnread: number;
  status: string;
  message?: ShapedSupportMessage | null;
}): void {
  publishEvent({
    type: input.type,
    audience: { userId: input.userId, roles: STAFF_ROLES },
    payload: {
      conversationId: input.conversationId,
      status: input.status,
      customerUnread: input.customerUnread,
      staffUnread: input.staffUnread,
      message: input.message ?? null,
      at: new Date().toISOString(),
    },
  });
}

/** Total unread across a shopper's conversations — powers the storefront bubble. */
export async function customerUnreadTotal(userId: string): Promise<number> {
  const result = await prisma.supportConversation.aggregate({
    where: { userId, status: SupportConversationStatus.OPEN },
    _sum: { customerUnread: true },
  });
  return result._sum.customerUnread ?? 0;
}

/**
 * Finds the shopper's open thread, or opens one.
 *
 * Returning the existing thread rather than stacking a second one is what makes
 * the storefront bubble behave like a chat window instead of a ticket form: the
 * shopper clicks "Chat", and continues where they left off.
 */
export async function openConversationForCustomer(input: {
  userId: string;
  subject?: string;
  orderId?: string | null;
  firstMessage?: string;
}): Promise<{ conversation: ShapedConversation; created: boolean }> {
  const existing = await prisma.supportConversation.findFirst({
    where: { userId: input.userId, status: SupportConversationStatus.OPEN },
    orderBy: { lastMessageAt: 'desc' },
  });

  if (existing) {
    // Point an unrelated open thread at the order the shopper is asking about
    // now, so the agent sees the context they actually need.
    if (input.orderId && existing.orderId !== input.orderId) {
      const updated = await prisma.supportConversation.update({
        where: { id: existing.id },
        data: { orderId: input.orderId },
      });
      return { conversation: shapeConversation(updated), created: false };
    }
    return { conversation: shapeConversation(existing), created: false };
  }

  // If the shopper names an order, fold its number into the subject so the
  // inbox list is scannable without opening the thread.
  let subject = input.subject?.trim() || 'New conversation';
  if (input.orderId && subject === 'New conversation') {
    const order = await prisma.order.findUnique({
      where: { id: input.orderId },
      select: { orderNumber: true, userId: true },
    });
    if (order) subject = `Order ${order.orderNumber}`;
  }

  const conversation = await prisma.supportConversation.create({
    data: {
      userId: input.userId,
      orderId: input.orderId ?? null,
      subject,
      status: SupportConversationStatus.OPEN,
    },
  });

  if (input.firstMessage?.trim()) {
    await appendMessage({
      conversationId: conversation.id,
      authorType: SupportAuthorType.CUSTOMER,
      authorUserId: input.userId,
      body: input.firstMessage.trim(),
    });
  }

  const refreshed = await prisma.supportConversation.findUniqueOrThrow({ where: { id: conversation.id } });
  return { conversation: shapeConversation(refreshed), created: true };
}

/** Customer-scoped list. The `userId` filter is the authorization boundary. */
export async function listConversationsForCustomer(userId: string): Promise<ShapedConversation[]> {
  const rows = await prisma.supportConversation.findMany({
    where: { userId },
    orderBy: { lastMessageAt: 'desc' },
    take: 20,
  });
  return rows.map((row) => shapeConversation(row));
}

export type InboxFilter = 'OPEN' | 'CLOSED' | 'ALL';

/** Staff list. Never scoped by user — an agent sees the whole queue. */
export async function listInbox(input: { status?: InboxFilter; assignedToMe?: string }): Promise<ShapedConversation[]> {
  const status = input.status ?? 'OPEN';
  const rows = await prisma.supportConversation.findMany({
    where: {
      ...(status === 'ALL' ? {} : { status: status as SupportConversationStatus }),
      ...(input.assignedToMe ? { assignedToUserId: input.assignedToMe } : {}),
    },
    orderBy: [{ staffUnread: 'desc' }, { lastMessageAt: 'desc' }],
    take: 100,
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
  });
  return rows.map((row) => shapeConversation(row, { includeCustomer: true }));
}

/**
 * Loads a conversation with its messages.
 *
 * `as` decides the scope: a customer load is filtered by `userId` so a
 * fabricated id returns 404 rather than another shopper's thread, while a staff
 * load is unscoped. Making the caller state the perspective is the point — an
 * unscoped read cannot be reached by accident.
 */
export async function getConversationWithMessages(input: {
  conversationId: string;
  as: { kind: 'customer'; userId: string } | { kind: 'staff' };
  markRead?: boolean;
}): Promise<{ conversation: ShapedConversation; messages: ShapedSupportMessage[] }> {
  const row = await prisma.supportConversation.findFirst({
    where: {
      id: input.conversationId,
      ...(input.as.kind === 'customer' ? { userId: input.as.userId } : {}),
    },
    include: {
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
      messages: {
        orderBy: { createdAt: 'asc' },
        take: 500,
        include: { author: { select: { firstName: true, lastName: true } } },
      },
    },
  });

  if (!row) throw AppError.notFound('Conversation');

  if (input.markRead !== false) {
    const data =
      input.as.kind === 'customer' ? { customerUnread: 0 } : { staffUnread: 0 };
    const cleared = row.customerUnread !== 0 || row.staffUnread !== 0;
    if (cleared) {
      const updated = await prisma.supportConversation.update({ where: { id: row.id }, data });
      Object.assign(row, updated);
      emitConversationEvent({
        type: 'support.conversation',
        conversationId: row.id,
        userId: row.userId,
        customerUnread: updated.customerUnread,
        staffUnread: updated.staffUnread,
        status: updated.status,
      });
    }
  }

  return {
    conversation: shapeConversation(row, { includeCustomer: input.as.kind === 'staff' }),
    messages: row.messages.map(shapeSupportMessage),
  };
}

/**
 * Appends a message and maintains the thread's denormalised state.
 *
 * The counters mean "messages from the *other* side that this side has not
 * seen", which is why the author's own counter is left alone: a shopper sending
 * a message must not make their own bubble say "1 unread".
 */
export async function appendMessage(input: {
  conversationId: string;
  authorType: SupportAuthorType;
  authorUserId: string | null;
  body: string;
}): Promise<{ message: ShapedSupportMessage; conversation: ShapedConversation }> {
  const body = input.body.trim();
  if (!body) throw AppError.validation('Message cannot be empty');
  if (body.length > 4000) throw AppError.validation('Message is too long');

  const conversation = await prisma.supportConversation.findUnique({ where: { id: input.conversationId } });
  if (!conversation) throw AppError.notFound('Conversation');

  const fromCustomer = input.authorType === SupportAuthorType.CUSTOMER;
  const fromAgent = input.authorType === SupportAuthorType.AGENT;

  const row = await prisma.supportMessage.create({
    data: {
      conversationId: input.conversationId,
      authorType: input.authorType,
      authorUserId: input.authorUserId,
      body,
    },
    include: { author: { select: { firstName: true, lastName: true } } },
  });

  const updated = await prisma.supportConversation.update({
    where: { id: input.conversationId },
    data: {
      lastMessageAt: row.createdAt,
      lastPreview: body.slice(0, MESSAGE_PREVIEW_CHARS),
      // A shopper replying to a closed thread is asking for help, not talking
      // to a wall: reopen it. An agent replying leaves the status alone.
      ...(fromCustomer ? { status: SupportConversationStatus.OPEN, staffUnread: { increment: 1 } } : {}),
      ...(fromAgent ? { customerUnread: { increment: 1 } } : {}),
      ...(fromAgent ? { assignedToUserId: conversation.assignedToUserId ?? input.authorUserId } : {}),
    },
  });

  const message = shapeSupportMessage(row);
  emitConversationEvent({
    type: 'support.message',
    conversationId: updated.id,
    userId: updated.userId,
    customerUnread: updated.customerUnread,
    staffUnread: updated.staffUnread,
    status: updated.status,
    message,
  });

  return { message, conversation: shapeConversation(updated) };
}

/** Assigns a conversation to an agent (or clears the assignment). */
export async function assignConversation(input: {
  conversationId: string;
  assignedToUserId: string | null;
}): Promise<ShapedConversation> {
  const existing = await prisma.supportConversation.findUnique({ where: { id: input.conversationId } });
  if (!existing) throw AppError.notFound('Conversation');

  const updated = await prisma.supportConversation.update({
    where: { id: input.conversationId },
    data: { assignedToUserId: input.assignedToUserId },
  });

  emitConversationEvent({
    type: 'support.conversation',
    conversationId: updated.id,
    userId: updated.userId,
    customerUnread: updated.customerUnread,
    staffUnread: updated.staffUnread,
    status: updated.status,
  });

  return shapeConversation(updated);
}

/** Opens or closes a conversation. Closing drops the shopper's unread badge. */
export async function setConversationStatus(input: {
  conversationId: string;
  status: SupportConversationStatus;
}): Promise<ShapedConversation> {
  const existing = await prisma.supportConversation.findUnique({ where: { id: input.conversationId } });
  if (!existing) throw AppError.notFound('Conversation');

  const updated = await prisma.supportConversation.update({
    where: { id: input.conversationId },
    data: {
      status: input.status,
      ...(input.status === SupportConversationStatus.CLOSED ? { customerUnread: 0 } : {}),
    },
  });

  emitConversationEvent({
    type: 'support.conversation',
    conversationId: updated.id,
    userId: updated.userId,
    customerUnread: updated.customerUnread,
    staffUnread: updated.staffUnread,
    status: updated.status,
  });

  return shapeConversation(updated);
}

/** Staff-side unread total, for the console badge. */
export async function staffUnreadTotal(): Promise<number> {
  const result = await prisma.supportConversation.aggregate({
    where: { status: SupportConversationStatus.OPEN },
    _sum: { staffUnread: true },
  });
  return result._sum.staffUnread ?? 0;
}
