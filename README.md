# event-bus 

A lightweight, zero-dependency pub/sub event bus for Node.js. Supports wildcard patterns, async handlers, retry with exponential backoff, dead-letter queue, and priority ordering.

## Why it exists

`EventEmitter` is bare-bones. Most pub/sub libraries are either too heavy or lack retry logic. This library is a small, self-contained event bus with exactly the features a real service needs.

## Install

```bash
npm install event-bus
```

## Quick start

```js
const { EventBus } = require('event-bus');

const bus = new EventBus();

// Subscribe
bus.on('user.created', async (user) => {
  await sendWelcomeEmail(user.email);
});

// Wildcard — matches user.created, user.deleted, etc.
bus.on('user.*', (payload, { event }) => {
  console.log(`Audit: ${event}`, payload);
});

// Emit
await bus.emit('user.created', { id: 1, email: 'alice@example.com' });
```

## API

### `bus.on(pattern, handler, options?)`
Subscribe to an event pattern. Returns a subscription id.

```js
const id = bus.on('order.*', handler, {
  priority: 10,      // higher = called first (default: 0)
  maxRetries: 3,     // retry on throw (default: 3)
  retryBaseMs: 100,  // exponential backoff base (default: 100ms)
  once: false,       // auto-unsubscribe after first emit
});
```

### `bus.once(pattern, handler, options?)`
Subscribe for exactly one emission, then auto-unsubscribe.

### `bus.off(id)`
Unsubscribe using the id returned by `on()`.

### `bus.emit(event, payload?)`
Emit an event asynchronously. Returns `Promise<{ event, handlersInvoked, errors }>`.

### `bus.emitSync(event, payload?)`
Emit synchronously (no retry support). Returns handler count.

### `bus.clear(pattern?)`
Remove all subscriptions, or only those matching a pattern.

### `bus.getHistory(filter?)`
Returns event history (requires `historySize > 0` in constructor).

### `bus.getDeadLetters()`
Returns entries that exhausted all retries.

## Wildcard patterns

| Pattern       | Matches                        | Does not match     |
|---------------|--------------------------------|--------------------|
| `user.*`      | `user.created`, `user.deleted` | `user.role.changed`|
| `order.**`    | `order.a`, `order.a.b.c`       | `cart.updated`     |
| `exact.event` | `exact.event` only             | anything else      |

## Retry & dead-letter queue

If a handler throws, the bus retries it with exponential backoff. After all retries are exhausted, the event is moved to the dead-letter queue.

```js
bus.on('payment.process', async (payload) => {
  await chargeCard(payload); // may throw transiently
}, { maxRetries: 3, retryBaseMs: 200 });

// After processing, inspect failures:
const failed = bus.getDeadLetters();
// [{ event, payload, lastError, attempts, timestamp }]
```

## Priority

```js
bus.on('request', auditHandler,  { priority: -1 }); // runs last
bus.on('request', authHandler,   { priority: 10 }); // runs first
bus.on('request', cacheHandler,  { priority: 5  }); // runs second
```

## Event history

```js
const bus = new EventBus({ historySize: 100 });

// ... emit events ...

bus.getHistory('user'); // all events starting with 'user'
```

## Constructor options

| Option        | Type     | Default | Description                          |
|---------------|----------|---------|--------------------------------------|
| `maxListeners`| number   | `100`   | Warn threshold per pattern            |
| `historySize` | number   | `0`     | Keep last N events (0 = disabled)    |
| `onError`     | function | `null`  | `(err, event, subId) => void`        |

## Running tests

```bash
node tests/event-bus.test.js
```

## Architecture

```
index.js                  ← public API
src/
  event-bus.js            ← full implementation (~280 lines)
examples/
  order-pipeline.js       ← e-commerce event flow demo
tests/
  event-bus.test.js       ← 15 unit tests, zero dependencies
```
