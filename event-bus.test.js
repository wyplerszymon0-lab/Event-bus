'use strict';

const assert = require('assert');
const { EventBus } = require('../index');

// ── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Tests ────────────────────────────────────────────────────────────────────

async function testBasicEmit() {
  const bus = new EventBus();
  let received = null;
  bus.on('test.event', (payload) => { received = payload; });
  await bus.emit('test.event', { value: 42 });
  assert.deepStrictEqual(received, { value: 42 });
  console.log('✓ basic emit delivers payload');
}

async function testMultipleHandlers() {
  const bus = new EventBus();
  const calls = [];
  bus.on('x', () => calls.push('a'));
  bus.on('x', () => calls.push('b'));
  await bus.emit('x');
  assert.strictEqual(calls.length, 2);
  console.log('✓ multiple handlers all invoked');
}

async function testOnce() {
  const bus = new EventBus();
  let count = 0;
  bus.once('ev', () => count++);
  await bus.emit('ev');
  await bus.emit('ev');
  assert.strictEqual(count, 1);
  assert.strictEqual(bus.listenerCount, 0, 'once sub should be removed');
  console.log('✓ once() fires exactly one time');
}

async function testOff() {
  const bus = new EventBus();
  let count = 0;
  const id = bus.on('ev', () => count++);
  await bus.emit('ev');
  bus.off(id);
  await bus.emit('ev');
  assert.strictEqual(count, 1);
  console.log('✓ off() removes subscription');
}

async function testWildcardSingleSegment() {
  const bus = new EventBus();
  const events = [];
  bus.on('user.*', (_, { event }) => events.push(event));
  await bus.emit('user.created');
  await bus.emit('user.deleted');
  await bus.emit('order.placed');    // should NOT match
  assert.deepStrictEqual(events, ['user.created', 'user.deleted']);
  console.log('✓ wildcard user.* matches single-segment events');
}

async function testWildcardNoMatchAcrossSegments() {
  const bus = new EventBus();
  const matched = [];
  bus.on('a.*', (_, { event }) => matched.push(event));
  await bus.emit('a.b.c');  // should NOT match — two segments after 'a'
  assert.strictEqual(matched.length, 0);
  console.log('✓ a.* does not match a.b.c (multi-segment)');
}

async function testPriority() {
  const bus = new EventBus();
  const order = [];
  bus.on('ev', () => order.push('low'),    { priority: 0  });
  bus.on('ev', () => order.push('high'),   { priority: 10 });
  bus.on('ev', () => order.push('medium'), { priority: 5  });
  await bus.emit('ev');
  assert.deepStrictEqual(order, ['high', 'medium', 'low']);
  console.log('✓ priority ordering: high before medium before low');
}

async function testRetryOnFailure() {
  const bus = new EventBus();
  let attempts = 0;
  bus.on('flaky', async () => {
    attempts++;
    if (attempts < 3) throw new Error('transient error');
  }, { maxRetries: 3, retryBaseMs: 5 });

  const result = await bus.emit('flaky');
  assert.strictEqual(attempts, 3);
  assert.strictEqual(result.errors, 0);
  console.log('✓ retry: handler succeeds on 3rd attempt');
}

async function testDeadLetterQueue() {
  const bus = new EventBus();
  bus.on('broken', async () => { throw new Error('always fails'); }, { maxRetries: 1, retryBaseMs: 5 });

  await bus.emit('broken');
  const dlq = bus.getDeadLetters();
  assert.strictEqual(dlq.length, 1);
  assert.strictEqual(dlq[0].event, 'broken');
  assert.strictEqual(dlq[0].attempts, 2); // 1 initial + 1 retry
  assert.ok(dlq[0].lastError instanceof Error);
  console.log('✓ exhausted retries end up in dead-letter queue');
}

async function testEmitSync() {
  const bus = new EventBus();
  let val = 0;
  bus.on('sync.ev', (n) => { val += n; });
  bus.on('sync.ev', (n) => { val += n; });
  const count = bus.emitSync('sync.ev', 5);
  assert.strictEqual(count, 2);
  assert.strictEqual(val, 10);
  console.log('✓ emitSync invokes handlers synchronously');
}

async function testHistory() {
  const bus = new EventBus({ historySize: 5 });
  for (let i = 0; i < 7; i++) await bus.emit(`ev.${i}`);
  const history = bus.getHistory();
  assert.strictEqual(history.length, 5);
  assert.strictEqual(history[0].event, 'ev.2'); // oldest kept
  console.log('✓ history capped at historySize, oldest dropped');
}

async function testClear() {
  const bus = new EventBus();
  bus.on('a', () => {});
  bus.on('b', () => {});
  assert.strictEqual(bus.listenerCount, 2);
  bus.clear();
  assert.strictEqual(bus.listenerCount, 0);
  console.log('✓ clear() removes all subscriptions');
}

async function testAsyncHandlers() {
  const bus = new EventBus();
  const results = [];
  bus.on('async', async (n) => {
    await sleep(10);
    results.push(n * 2);
  });
  await bus.emit('async', 21);
  assert.deepStrictEqual(results, [42]);
  console.log('✓ async handlers awaited correctly');
}

async function testEmitResultShape() {
  const bus = new EventBus();
  bus.on('x', () => {});
  bus.on('x', () => {});
  const result = await bus.emit('x', 'data');
  assert.strictEqual(result.event, 'x');
  assert.strictEqual(result.handlersInvoked, 2);
  assert.strictEqual(result.errors, 0);
  console.log('✓ emit() returns correct result shape');
}

async function testNoListeners() {
  const bus = new EventBus();
  const result = await bus.emit('ghost.event');
  assert.strictEqual(result.handlersInvoked, 0);
  console.log('✓ emitting to unsubscribed event returns 0 handlers');
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function runAll() {
  const tests = [
    testBasicEmit,
    testMultipleHandlers,
    testOnce,
    testOff,
    testWildcardSingleSegment,
    testWildcardNoMatchAcrossSegments,
    testPriority,
    testRetryOnFailure,
    testDeadLetterQueue,
    testEmitSync,
    testHistory,
    testClear,
    testAsyncHandlers,
    testEmitResultShape,
    testNoListeners,
  ];

  for (const test of tests) {
    await test();
  }

  console.log(`\n✅ All ${tests.length} tests passed`);
}

runAll().catch((err) => {
  console.error('\n❌ Test failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
