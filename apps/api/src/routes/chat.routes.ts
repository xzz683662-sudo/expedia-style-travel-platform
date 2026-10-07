import { SupportConversationStatus } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { requireAuth, requireRole } from '../plugins/auth';
import {
  appendMessage,
  assignConversation,
  customerUnreadTotal,
  getConversationWithMessages,
  listConversationsForCustomer,
  listInbox,
  openConversationForCustomer,
  setConversationStatus,
  staffUnreadTotal,
} from '../modules/support/chat';
import { AppError } from '../utils/errors';
import { SupportAuthorType } from '@prisma/client';

/**
 * ---------------------------------------------------------------------------
 * Support chat API
 * ---------------------------------------------------------------------------
 *
 * Two surfaces over one domain module:
 *
 *   `/support/conversations/*`  the shopper's own threads (customer token)
 *   `/support/inbox/*`          the whole queue (SUPPORT or ADMIN token)
 *
 * The customer routes never take a `userId` — it always comes from the token.
 * That is the difference between "a shopper reads their chat" and "a shopper
 * reads a chat id they guessed", and it is enforced in the module, not here.
 */

const messageBody = z.object({ body: z.string().trim().min(1).max(4000) });

const openBody = z.object({
  subject: z.string().trim().max(140).optional(),
  orderId: z.string().min(1).optional(),
  message: z.string().trim().max(4000).optional(),
});

const inboxQuery = z.object({
  status: z.enum(['OPEN', 'CLOSED', 'ALL']).optional(),
  assignedToMe: z.coerce.boolean().optional(),
});

const staffOnly = { preHandler: [requireRole('SUPPORT', 'ADMIN')] };

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Shopper side
  // -------------------------------------------------------------------------

  /** Opens (or resumes) the signed-in shopper's conversation. */
  app.post('/support/conversations', {}, async (request, reply) => {
    const user = requireAuth(request);
    const body = openBody.parse(request.body ?? {});

    if (body.orderId) {
      // A shopper may only attach their own order. Checking here keeps the
      // module free of a cross-domain lookup it has no business doing.
      const order = await prisma.order.findFirst({
        where: { id: body.orderId, userId: user.id },
        select: { id: true },
      });
      if (!order) throw AppError.notFound('Order');
    }

    const result = await openConversationForCustomer({
      userId: user.id,
      subject: body.subject,
      orderId: body.orderId ?? null,
      firstMessage: body.message,
    });

    return reply.status(result.created ? 201 : 200).send(result.conversation);
  });

  app.get('/support/conversations/mine', async (request) => {
    const user = requireAuth(request);
    const items = await listConversationsForCustomer(user.id);
    return { items, unread: await customerUnreadTotal(user.id) };
  });

  app.get('/support/conversations/:id', async (request) => {
    const user = requireAuth(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);

    const result = await getConversationWithMessages({
      conversationId: id,
      as: { kind: 'customer', userId: user.id },
      markRead: true,
    });

    return { ...result, unread: await customerUnreadTotal(user.id) };
  });

  app.post('/support/conversations/:id/messages', {}, async (request, reply) => {
    const user = requireAuth(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = messageBody.parse(request.body);

    // Ownership check before the write: the module's `appendMessage` is scoped
    // by conversation id alone, so the perspective has to be proven here.
    const owned = await prisma.supportConversation.findFirst({
      where: { id, userId: user.id },
      select: { id: true },
    });
    if (!owned) throw AppError.notFound('Conversation');

    const result = await appendMessage({
      conversationId: id,
      authorType: SupportAuthorType.CUSTOMER,
      authorUserId: user.id,
      body: body.body,
    });

    return reply.status(201).send(result.message);
  });

  // -------------------------------------------------------------------------
  // Staff side
  // -------------------------------------------------------------------------

  app.get('/support/inbox', staffOnly, async (request) => {
    const user = requireAuth(request);
    const query = inboxQuery.parse(request.query ?? {});

    const items = await listInbox({
      status: query.status,
      assignedToMe: query.assignedToMe ? user.id : undefined,
    });

    return { items, unread: await staffUnreadTotal() };
  });

  app.get('/support/inbox/:id', staffOnly, async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);

    const result = await getConversationWithMessages({
      conversationId: id,
      as: { kind: 'staff' },
      markRead: true,
    });

    return { ...result, unread: await staffUnreadTotal() };
  });

  app.post('/support/inbox/:id/messages', staffOnly, async (request, reply) => {
    const user = requireAuth(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = messageBody.parse(request.body);

    const result = await appendMessage({
      conversationId: id,
      authorType: SupportAuthorType.AGENT,
      authorUserId: user.id,
      body: body.body,
    });

    return reply.status(201).send(result.message);
  });

  app.post('/support/inbox/:id/assign', staffOnly, async (request) => {
    const user = requireAuth(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    // An explicit `null` unassigns; omitting the field assigns to the caller,
    // which is the common case ("I'll take this one").
    const body = z.object({ assignedToUserId: z.string().min(1).nullable().optional() }).parse(request.body ?? {});

    const conversation = await assignConversation({
      conversationId: id,
      assignedToUserId: body.assignedToUserId === undefined ? user.id : body.assignedToUserId,
    });

    logger.info('support.conversation_assigned', { conversationId: id, by: user.id });
    return conversation;
  });

  app.post('/support/inbox/:id/close', staffOnly, async (request) => {
    const user = requireAuth(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);

    const conversation = await setConversationStatus({
      conversationId: id,
      status: SupportConversationStatus.CLOSED,
    });

    logger.info('support.conversation_closed', { conversationId: id, by: user.id });
    return conversation;
  });

  app.post('/support/inbox/:id/reopen', staffOnly, async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);

    return setConversationStatus({
      conversationId: id,
      status: SupportConversationStatus.OPEN,
    });
  });
}
