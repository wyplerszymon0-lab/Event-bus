'use strict';

/**
 * examples/order-pipeline.js
 *
 * Simulates an e-commerce order pipeline using EventBus.
 * Events flow: order.placed → order.payment.* → order.fulfilled / order.cancelled
 *
 * Run: node examples/order-pipeline.js
 */

const { EventBus } = require('../index');

const bus = new EventBus({ historySize: 50 });

// ── Inventory service ────────────────────────────────────────────────────────
bus.on('order.placed', async ({ orderId, items }) => {
  console.log(`[Inventory] Reserving stock for order ${orderId}...`);
  await sleep(50);
  console.log(`[Inventory] ✓ Stock reserved for ${items.length} item(s)`);
});

// ── Payment service ──────────────────────────────────────────────────────────
bus.on('order.placed', async ({ orderId, total }) => {
  console.log(`[Payment] Charging $${total} for order ${orderId}...`);
  await sleep(80);

  // Simulate occasional payment failure
  if (total > 999) {
    await bus.emit('order.payment.failed', { orderId, reason: 'Card declined' });
  } else {
    await bus.emit('order.payment.succeeded', { orderId });
  }
});

// ── Fulfilment service — wildcard subscription ───────────────────────────────
bus.on('order.payment.*', async ({ orderId, reason }) => {
  const event = `order.payment.*`;
  console.log(`[Fulfilment] Payment event received for ${orderId}`);
});

bus.on('order.payment.succeeded', async ({ orderId }) => {
  console.log(`[Fulfilment] Packing order ${orderId}...`);
  await sleep(30);
  await bus.emit('order.fulfilled', { orderId });
});

bus.on('order.payment.failed', async ({ orderId, reason }) => {
  console.log(`[Fulfilment] ✗ Cancelling order ${orderId}: ${reason}`);
  await bus.emit('order.cancelled', { orderId, reason });
});

// ── Notification service — wildcard for all order events ────────────────────
bus.on('order.*', ({ orderId }, { event }) => {
  console.log(`[Notify] SMS sent to customer for event: ${event} (order ${orderId})`);
}, { priority: -1 }); // run last

// ── Analytics service — one-shot for first order ────────────────────────────
bus.once('order.placed', ({ orderId }) => {
  console.log(`[Analytics] 🎉 First order event captured: ${orderId}`);
});

// ── Retry demo ───────────────────────────────────────────────────────────────
let auditAttempts = 0;
bus.on('order.fulfilled', async ({ orderId }) => {
  auditAttempts++;
  if (auditAttempts < 2) throw new Error('Audit DB temporarily unavailable');
  console.log(`[Audit] ✓ Order ${orderId} written to audit log (after retry)`);
}, { maxRetries: 3, retryBaseMs: 20 });

// ── Run ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Order Pipeline Demo ===\n');

  console.log('--- Order 1: $49.99 (should succeed) ---');
  await bus.emit('order.placed', { orderId: 'ORD-001', items: ['book', 'pen'], total: 49.99 });

  console.log('\n--- Order 2: $1299 (payment will fail) ---');
  await bus.emit('order.placed', { orderId: 'ORD-002', items: ['laptop'], total: 1299 });

  console.log('\n--- Event history ---');
  const history = bus.getHistory();
  history.forEach(({ event, timestamp }) =>
    console.log(`  ${new Date(timestamp).toISOString().slice(11, 19)} ${event}`)
  );

  const dlq = bus.getDeadLetters();
  if (dlq.length) {
    console.log('\n--- Dead-letter queue ---');
    dlq.forEach((d) => console.log(`  ${d.event} → ${d.lastError.message} (${d.attempts} attempts)`));
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch(console.error);
