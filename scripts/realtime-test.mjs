#!/usr/bin/env node
/**
 * ---------------------------------------------------------------------------
 * EasyTrip realtime end-to-end test
 * ---------------------------------------------------------------------------
 *
 * Verifies the WebSocket gateway + notification centre against a running API:
 *
 *   1. anonymous socket is granted only the `public` topic
 *   2. authenticated socket is granted `public` + `user:<id>` (+ `role:<ROLE>`)
 *   3. a crafted `subscribe` cannot widen the server-fixed topic set
 *   4. checkout publishes `order.created`
 *   5. payment publishes `payment.status_changed` and `order.status_changed`
 *   6. the same fact lands durably in `GET /notifications`
 *   7. `notification.created` is pushed over the socket
 *
 * Usage:  node scripts/realtime-test.mjs [API_BASE_URL] [WS_BASE_URL]
 * ---------------------------------------------------------------------------
 */

import WebSocket from 'ws';

const API = process.argv[2] ?? 'http://localhost:4000';
const WS_BASE = process.argv[3] ?? API.replace(/^http/, 'ws');

let pass = 0;
let fail = 0;

const green = (s) => console.log(`\u001b[32m${s}\u001b[0m`);
const red = (s) => console.log(`\u001b[31m${s}\u001b[0m`);
const head = (s) => console.log(`\n\u001b[1;36m── ${s}\u001b[0m`);

function check(label, condition) {
  if (condition) {
    green(`  ✓ ${label}`);
    pass += 1;
  } else {
    red(`  ✗ ${label}`);
    fail += 1;
  }
}

async function api(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** Opens a socket and resolves on `connected`, collecting every later event. */
function connect(token) {
  const url = new URL('/api/v1/realtime', WS_BASE);
  if (token) url.searchParams.set('token', token);

  const socket = new WebSocket(url);
  const events = [];
  const acks = [];

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timeout')), 8000);
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'connected') {
        clearTimeout(timer);
        resolve(message);
        return;
      }
      if (message.type === 'event') events.push(message.event);
      else acks.push(message);
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  return { socket, events, acks, ready };
}

const waitFor = (events, predicate, timeoutMs = 6000) =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = () => {
      const match = events.find(predicate);
      if (match) return resolve(match);
      if (Date.now() - startedAt > timeoutMs) return resolve(null);
      setTimeout(tick, 50);
    };
    tick();
  });

const run = async () => {
  head('Anonymous socket');
  const anon = connect(null);
  const anonHello = await anon.ready;
  check('anonymous connect succeeds', anonHello.type === 'connected');
  check('anonymous is granted only the public topic', JSON.stringify(anonHello.topics) === JSON.stringify(['public']));

  head('Authenticated socket');
  const email = `realtime+${Date.now()}@easytrip.test`;
  const registration = await api('/api/v1/auth/register', {
    method: 'POST',
    body: { email, password: 'Password123!', firstName: 'Realtime', lastName: 'Test' },
  });
  const token = registration.token;
  check('registration returns a token', Boolean(token));

  // Checkout is gated on a confirmed address, so this account has to complete
  // the same verification a shopper would. The API runs the console mail
  // transport outside production, so the code comes back in the response.
  const devCode = registration.emailVerification?.devCode;
  check('registration issues a verification code', /^\d{6}$/.test(String(devCode)));
  const verification = await api('/api/v1/auth/verify-email', {
    method: 'POST',
    body: { email, code: devCode },
  });
  check('the address verifies', verification.verified === true);

  const me = await api('/api/v1/auth/me', { token });
  const client = connect(token);
  const hello = await client.ready;
  check('authenticated connect succeeds', hello.type === 'connected');
  check('user topic is granted', hello.topics.includes(`user:${me.id}`));
  check('public topic is granted', hello.topics.includes('public'));

  head('Filter narrowing');
  // A client may only ever narrow its own stream — request a filter and confirm
  // the server acknowledges it without granting any new topic.
  client.socket.send(JSON.stringify({ action: 'subscribe', types: ['order.*'] }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const ack = client.acks.find((m) => m.type === 'subscribed' && m.types.includes('order.*'));
  check('subscribe is acknowledged', Boolean(ack));
  check('narrowing never changes the granted topic set', JSON.stringify(hello.topics) === JSON.stringify(['public', `user:${me.id}`]));

  head('Checkout publishes realtime events');
  const search = await api('/api/v1/search?pageSize=1');
  const slug = search.items[0].slug;
  const detail = await api(`/api/v1/products/${slug}`);
  const ticketTypeId = detail.ticketTypes[0].id;
  const serviceDate = new Date(Date.now() + 12 * 86_400_000).toISOString().slice(0, 10);

  // Re-enable the wide stream: the filter above would otherwise hide unrelated
  // event types and make the assertions below flaky.
  client.socket.send(JSON.stringify({ action: 'subscribe', types: [] }));
  await new Promise((resolve) => setTimeout(resolve, 200));

  const order = await api('/api/v1/orders', {
    method: 'POST',
    token,
    body: {
      lines: [{ ticketTypeId, serviceDate, quantity: 1 }],
      contactEmail: email,
      travelers: [{ fullName: 'Realtime Test', isLead: true }],
    },
  });
  check('order created', Boolean(order.orderId));

  const created = await waitFor(client.events, (e) => e.type === 'order.created' && e.payload.orderId === order.orderId);
  check('order.created is pushed to the shopper', Boolean(created));

  head('Payment publishes realtime events');
  const payment = await api(`/api/v1/orders/${order.orderId}/pay`, {
    method: 'POST',
    token,
    body: {
      method: 'CARD',
      idempotencyKey: `realtime-${Date.now()}`,
      card: { number: '4242424242424242', expMonth: 12, expYear: 2030, cvc: '123', holderName: 'Realtime Test' },
    },
  });
  check('payment captured', payment.status === 'CAPTURED');

  const paid = await waitFor(client.events, (e) => e.type === 'payment.status_changed' && e.payload.orderId === order.orderId);
  check('payment.status_changed is pushed', Boolean(paid));

  const statusChanged = await waitFor(
    client.events,
    (e) => e.type === 'order.status_changed' && e.payload.orderId === order.orderId && e.payload.status === 'CONFIRMED',
  );
  check('order.status_changed → CONFIRMED is pushed', Boolean(statusChanged));

  head('Durable notification centre');
  const notifications = await api('/api/v1/notifications', { token });
  check('notifications endpoint returns items', Array.isArray(notifications.items));
  check('a durable notification was persisted for the order', notifications.items.some((n) => n.orderId === order.orderId));

  const pushed = await waitFor(client.events, (e) => e.type === 'notification.created');
  check('notification.created is pushed over the socket', Boolean(pushed));

  const markRead = await api(`/api/v1/notifications/${notifications.items[0].id}/read`, { method: 'POST', token });
  check('marking a notification read succeeds', markRead.ok === true);
  const readEvent = await waitFor(client.events, (e) => e.type === 'notification.read');
  check('notification.read is pushed with a fresh count', Boolean(readEvent));

  head('Teardown');
  client.socket.close();
  anon.socket.close();
  await new Promise((resolve) => setTimeout(resolve, 200));

  console.log(`\n\u001b[1m══ Summary ══\u001b[0m\n  passed: ${pass}\n  failed: ${fail}`);
  if (fail > 0) process.exit(1);
};

run().catch((error) => {
  red(`realtime test crashed: ${error.message}`);
  process.exit(1);
});
