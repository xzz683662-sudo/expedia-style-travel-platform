import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import type Redis from 'ioredis';
import { logger } from '../../lib/logger';
import { createSubscriberClient, getRedis, hasRealRedis } from '../../utils/redis';

/**
 * ---------------------------------------------------------------------------
 * Realtime event bus
 * ---------------------------------------------------------------------------
 *
 * A thin fan-out layer between the domain engines and the WebSocket gateway.
 *
 *   booking / inventory / payments engines
 *            │  publishEvent(...)
 *            ▼
 *        ┌────────┐   Redis Pub/Sub   ┌──────────────┐
 *        │  bus   │ ◀────(optional)──▶│ other API    │
 *        └────────┘                   │ instances    │
 *            │ local EventEmitter     └──────────────┘
 *            ▼
 *        WebSocket subscribers
 *
 * Two deliberate properties:
 *
 *  1. **Delivery is authorized server-side, filtering is done client-side.**
 *     A connection is granted a fixed set of *topics* derived from its identity
 *     (`user:<id>`, `role:<ROLE>`, `public`). Which event types it then cares
 *     about is a client concern. This means a client can never widen its own
 *     visibility — a customer socket cannot subscribe itself into another user's
 *     order events, no matter what it sends.
 *
 *  2. **Redis is an accelerator, never a hard dependency.** Without Redis the
 *     bus keeps working inside one process, which is exactly how the rest of the
 *     platform already treats Redis (see `utils/redis.ts`).
 */

export const REALTIME_CHANNEL = 'easytrip:realtime';

/** Staff roles that are allowed to observe operational (cross-customer) events. */
export const STAFF_ROLES = ['ADMIN', 'SUPPORT'] as const;

export type RealtimeAudience = {
  /** Deliver to this shopper's personal topic. */
  userId?: string | null;
  /** Deliver to every connected session holding one of these staff roles. */
  roles?: readonly string[];
  /** Deliver to every connected client, signed in or not. */
  broadcast?: boolean;
};

export type RealtimeEvent = {
  id: string;
  /** Dotted event name, e.g. `order.status_changed`, `inventory.low_stock`. */
  type: string;
  /** ISO timestamp, so clients can order or display events without a clock. */
  at: string;
  audience: RealtimeAudience;
  payload: Record<string, unknown>;
};

/** Event as it travels over Redis: the origin id suppresses the local echo. */
type WireEvent = RealtimeEvent & { origin: string };

export type NewRealtimeEvent = Omit<RealtimeEvent, 'id' | 'at'> & { id?: string; at?: string };

const emitter = new EventEmitter();
// Many WebSocket sessions can subscribe; the default cap of 10 is far too low.
emitter.setMaxListeners(0);

const INSTANCE_ID = randomUUID();

/**
 * Resolves the topics an event must be delivered to.
 *
 * Kept as a pure function so the WebSocket gateway and the bus both use the
 * exact same rules — a mismatch here is a data-leak bug, not a cosmetic one.
 */
export function topicsFor(event: RealtimeEvent): string[] {
  const topics: string[] = [];

  if (event.audience.broadcast) topics.push('public');
  if (event.audience.userId) topics.push(`user:${event.audience.userId}`);
  for (const role of event.audience.roles ?? []) topics.push(`role:${role}`);

  return topics;
}

/** Topics a freshly-connected session is allowed to listen on. */
export function grantedTopics(user: { id: string; role: string } | null): string[] {
  const topics = ['public'];
  if (!user) return topics;

  topics.push(`user:${user.id}`);
  if ((STAFF_ROLES as readonly string[]).includes(user.role)) topics.push(`role:${user.role}`);
  return topics;
}

function publishLocal(event: RealtimeEvent): void {
  // `EventEmitter.emit` runs listeners synchronously, so a throwing subscriber
  // would otherwise propagate into the domain call that published the event —
  // e.g. rolling back a confirmed booking because a socket misbehaved.
  try {
    emitter.emit('event', event);
  } catch (error) {
    logger.warn('realtime.listener_failed', { type: event.type, reason: (error as Error).message });
  }
}

/** Publishes to every API instance via Redis. Best effort by design. */
function publishToRedis(event: RealtimeEvent): void {
  if (!hasRealRedis()) return;
  try {
    const wire: WireEvent = { ...event, origin: INSTANCE_ID };
    // ioredis returns a promise; a rejected publish only costs cross-instance
    // delivery, so it must never surface as an unhandled rejection.
    void (getRedis() as Redis).publish(REALTIME_CHANNEL, JSON.stringify(wire)).catch(() => undefined);
  } catch {
    /* realtime is best-effort */
  }
}

/**
 * Publishes an event. Always returns the enriched event so callers can log it
 * or reuse the generated id.
 */
export function publishEvent(input: NewRealtimeEvent): RealtimeEvent {
  const event: RealtimeEvent = {
    id: input.id ?? randomUUID(),
    type: input.type,
    at: input.at ?? new Date().toISOString(),
    audience: input.audience,
    payload: input.payload,
  };

  publishLocal(event);
  publishToRedis(event);

  return event;
}

export type RealtimeListener = (event: RealtimeEvent) => void;

/**
 * Subscribes to every event published in this process.
 *
 * The Redis bridge is attached once, lazily, on the first listener, so a
 * deployment without any WebSocket traffic never opens a second connection.
 */
export function subscribeEvents(listener: RealtimeListener): () => void {
  emitter.on('event', listener);
  ensureRedisBridge();

  return () => {
    emitter.off('event', listener);
  };
}

let bridge: Redis | null = null;
let bridgeAttached = false;

function ensureRedisBridge(): void {
  if (bridgeAttached) return;
  bridgeAttached = true;

  if (!hasRealRedis()) {
    logger.info('realtime.bus_local_only', {
      note: 'no REDIS_URL configured — realtime events stay inside this process',
    });
    return;
  }

  bridge = createSubscriberClient();
  if (!bridge) return;

  bridge.on('message', (channel: string, message: string) => {
    if (channel !== REALTIME_CHANNEL) return;

    try {
      const wire = JSON.parse(message) as WireEvent;
      // Our own publish already fanned out locally; re-emitting would double
      // every event for local subscribers.
      if (wire.origin === INSTANCE_ID) return;

      const { origin: _origin, ...event } = wire;
      publishLocal(event as RealtimeEvent);
    } catch (error) {
      logger.warn('realtime.bus_decode_failed', { reason: (error as Error).message });
    }
  });

  bridge
    .subscribe(REALTIME_CHANNEL)
    .then(() => logger.info('realtime.bus_redis_attached', { channel: REALTIME_CHANNEL }))
    .catch((error: Error) => logger.warn('realtime.bus_subscribe_failed', { reason: error.message }));
}

/** Test/teardown helper — releases the dedicated subscriber connection. */
export async function closeRealtimeBus(): Promise<void> {
  const subscriber = bridge;
  bridge = null;
  bridgeAttached = false;
  if (!subscriber) return;

  await subscriber.quit().catch(() => undefined);
  subscriber.disconnect();
}
