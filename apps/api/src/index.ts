import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFile } from 'fs/promises';
import { join, normalize } from 'path';
import { config } from './config/env';
import { logger } from './lib/logger';
import { checkDatabase, connectDatabase, prisma } from './lib/prisma';
import { assertSearchEngine } from './modules/search/service';
import { closeRealtimeBus } from './modules/realtime/bus';
import { getPaymentGateway } from './modules/payments/gateway';
import { getRedis } from './utils/redis';
import { optionalAuth } from './plugins/auth';
import { registerErrorHandler } from './plugins/error-handler';
import { adminRoutes } from './routes/admin.routes';
import { authRoutes } from './routes/auth.routes';
import { cartRoutes } from './routes/cart.routes';
import { chatRoutes } from './routes/chat.routes';
import { accountRoutes } from './routes/account.routes';
import { inventoryFeedRoutes } from './routes/inventory-feed.routes';
import { itineraryRoutes, loyaltyRoutes } from './routes/loyalty.routes';
import { notificationRoutes } from './routes/notifications.routes';
import { orderRoutes } from './routes/orders.routes';
import { productRoutes } from './routes/products.routes';
import { promoRoutes } from './routes/promo.routes';
import { realtimeRoutes, realtimeStats } from './routes/realtime.routes';
import { searchRoutes } from './routes/search.routes';
import { socialRoutes } from './routes/social.routes';
import { supportRoutes } from './routes/support.routes';
import { ticketingRoutes } from './routes/ticketing.routes';
import { releaseExpiredHolds } from './modules/inventory/engine';
import { startTrvlWarmer } from './modules/supply/trvl-warmer';
import { expireOrder } from './modules/booking/engine';
import { OrderStatus } from '@prisma/client';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // we use our own structured logger
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: (origin, cb) => {
      // Requests without an Origin header are server-to-server: webhooks, the
      // mock gateway, curl. Those are not browser requests, so CORS does not
      // apply to them.
      if (!origin) return cb(null, true);

      const allowed = [
        config.site.url,
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        // Public storefront origin (tunnel / reverse proxy). Without this the
        // page loads but every browser fetch to the API fails CORS.
        ...(config.publicUrl ? [config.publicUrl] : []),
      ];

      if (allowed.includes(origin)) return cb(null, true);

      logger.warn('cors.origin_rejected', { origin });
      return cb(null, false);
    },
    credentials: true,
  });

  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: `${config.rateLimit.windowSeconds} seconds`,
    keyGenerator: (request) => request.ip,
    // Webhooks and order creation are exempt: they are either server-to-server
    // or already protected by idempotency keys + inventory holds.
    allowList: (request) =>
      request.url.includes('/webhooks/') || (request.url.includes('/orders') && request.method === 'POST'),
  });

  registerErrorHandler(app);
  await app.register(optionalAuth);

  // ---------------------------------------------------------------------------
  // Realtime transport
  // ---------------------------------------------------------------------------
  // Must be registered before the realtime routes: the plugin decorates the
  // route shorthand with the `websocket: true` option they rely on.
  await app.register(websocket, {
    options: {
      // Client frames are tiny control messages; 4 KB is already generous and
      // keeps a hostile client from buffering anything meaningful.
      maxPayload: 4096,
    },
  });

  // ---------------------------------------------------------------------------
  // Ticket artefacts
  // ---------------------------------------------------------------------------
  // Tickets are written to S3/MinIO when object storage is configured, and to
  // the local disk otherwise. The DB stores whichever URL was produced, so the
  // web client has to be able to read *both* shapes. Anything arriving as a
  // `file://` path is re-served over HTTP here.
  app.get('/media/tickets/:ticketNumber/:file', async (request, reply) => {
    const { ticketNumber, file } = request.params as { ticketNumber: string; file: string };

    // Allow-list the filename shapes we actually emit — this route must never
    // become an arbitrary file read on the host.
    if (!/^TKT-[A-Z0-9-]+$/.test(ticketNumber) || !/^(ticket\.pdf|qr\.png)$/.test(file)) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Artefact not found' } });
    }

    const root = normalize(config.storage.localDir);
    const target = normalize(join(root, 'tickets', ticketNumber, file));
    if (!target.startsWith(root)) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Artefact not found' } });
    }

    try {
      const body = await readFile(target);
      reply
        .header('Content-Type', file.endsWith('.pdf') ? 'application/pdf' : 'image/png')
        .header('Cache-Control', 'private, max-age=3600')
        .send(body);
    } catch {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Artefact not found' } });
    }
  });

  // ---------------------------------------------------------------------------
  // Health & readiness
  // ---------------------------------------------------------------------------
  app.get('/health', async () => ({ status: 'ok', service: 'easytrip-api', env: config.env, uptime: process.uptime() }));

  app.get('/ready', async (_request, reply) => {
    const checks: Record<string, boolean> = {};

    checks.database = await checkDatabase();
    try {
      checks.redis = (await getRedis().ping()) === 'PONG';
    } catch {
      checks.redis = false;
    }
    checks.payments = await getPaymentGateway().healthCheck();
    checks.search = true; // OpenSearch is optional; Postgres fallback always works

    const ready = Object.values(checks).every(Boolean);
    if (!ready) reply.status(503);

    return { ready, checks, realtime: realtimeStats() };
  });

  // ---------------------------------------------------------------------------
  // Domain routes
  // ---------------------------------------------------------------------------
  await app.register(searchRoutes, { prefix: '/api/v1' });
  await app.register(productRoutes, { prefix: '/api/v1' });
  await app.register(authRoutes, { prefix: '/api/v1' });
  await app.register(cartRoutes, { prefix: '/api/v1' });
  await app.register(accountRoutes, { prefix: '/api/v1' });
  await app.register(orderRoutes, { prefix: '/api/v1' });
  await app.register(ticketingRoutes, { prefix: '/api/v1' });
  await app.register(socialRoutes, { prefix: '/api/v1' });
  await app.register(loyaltyRoutes, { prefix: '/api/v1' });
  await app.register(itineraryRoutes, { prefix: '/api/v1' });
  await app.register(adminRoutes, { prefix: '/api/v1' });
  // Flag-gated: returns 404 while INVENTORY_FEED_ENABLED=false.
  await app.register(inventoryFeedRoutes, { prefix: '/api/v1' });
  await app.register(promoRoutes, { prefix: '/api/v1' });
  await app.register(supportRoutes, { prefix: '/api/v1' });
  await app.register(chatRoutes, { prefix: '/api/v1' });
  await app.register(notificationRoutes, { prefix: '/api/v1' });
  await app.register(realtimeRoutes, { prefix: '/api/v1' });

  app.get('/', async () => ({
    service: 'EasyTrip API',
    version: '1.0.0',
    docs: '/api/v1',
    health: '/health',
  }));

  return app;
}

/**
 * Background sweeper: releases expired inventory holds and expires stale
 * pending orders. In production this should be a separate worker process; here
 * it runs as a lightweight interval inside the API.
 */
function startBackgroundJobs(): NodeJS.Timeout {
  const run = async () => {
    try {
      await releaseExpiredHolds(200);

      const stale = await prisma.order.findMany({
        where: { status: OrderStatus.PENDING_PAYMENT, expiresAt: { lt: new Date() } },
        select: { id: true },
        take: 50,
      });
      for (const order of stale) {
        await expireOrder(order.id).catch((error) => logger.warn('expire_order_failed', { orderId: order.id, reason: (error as Error).message }));
      }
    } catch (error) {
      logger.error('background_job_failed', { reason: (error as Error).message });
    }
  };

  // Run shortly after boot, then every minute.
  setTimeout(() => void run(), 5_000);
  return setInterval(() => void run(), 60_000);
}

async function main(): Promise<void> {
  const app = await buildServer();

  try {
    await connectDatabase();
    logger.info('database.connected');
  } catch (error) {
    logger.error('database.connection_failed', { reason: (error as Error).message });
    process.exit(1);
  }

  assertSearchEngine();
  const gateway = getPaymentGateway();

  await app.listen({ port: config.port, host: config.host });

  logger.info('server.started', {
    port: config.port,
    env: config.env,
    paymentProvider: gateway.name,
    searchEngine: config.search.enabled ? 'opensearch' : 'postgres',
  });

  const sweeper = startBackgroundJobs();
  // Null when trvl is disabled, in which case there is nothing to clean up.
  const warmer = startTrvlWarmer();

  const shutdown = async (signal: string) => {
    logger.info('server.shutdown_requested', { signal });
    clearInterval(sweeper);
    if (warmer) clearInterval(warmer);
    await app.close();
    await closeRealtimeBus();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('server.start_failed', { reason: (error as Error).message });
    process.exit(1);
  });
}