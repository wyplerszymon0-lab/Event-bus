'use strict';

/**
 * EventBus — lightweight pub/sub with:
 *  - Wildcard subscriptions  (user.*)
 *  - Typed event history
 *  - Retry logic with exponential backoff
 *  - Dead-letter queue for exhausted retries
 *  - Async handler support
 *  - Once (one-shot) subscriptions
 *  - Priority ordering per event
 *  - Zero dependencies
 */

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 100;
const DEFAULT_MAX_LISTENERS = 100;

/**
 * @typedef {Object} Subscription
 * @property {string}   id
 * @property {string}   pattern       - exact event name or wildcard pattern
 * @property {Function} handler
 * @property {boolean}  once
 * @property {number}   priority      - higher = called first
 * @property {number}   maxRetries
 * @property {number}   retryBaseMs
 */

/**
 * @typedef {Object} DeadLetterEntry
 * @property {string}   event
 * @property {*}        payload
 * @property {string}   subscriptionId
 * @property {string}   pattern
 * @property {Error}    lastError
 * @property {number}   attempts
 * @property {number}   timestamp
 */

/**
 * @typedef {Object} EmitResult
 * @property {string}   event
 * @property {number}   handlersInvoked
 * @property {number}   errors
 */

class EventBus {
  constructor(options = {}) {
    const {
      maxListeners = DEFAULT_MAX_LISTENERS,
      onError = null,         // (err, event, subscriptionId) => void
      historySize = 0,        // 0 = disabled
    } = options;

    this._maxListeners = maxListeners;
    this._onError = onError;
    this._historySize = historySize;

    /** @type {Map<string, Subscription[]>} pattern → sorted subscription list */
    this._subscriptions = new Map();

    /** @type {Map<string, Subscription>} id → subscription (for fast unsubscribe) */
    this._byId = new Map();

    /** @type {DeadLetterEntry[]} */
    this._deadLetterQueue = [];

    /** @type {Array<{event: string, payload: *, timestamp: number}>} */
    this._history = [];

    this._idCounter = 0;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  _nextId() {
    return `sub_${++this._idCounter}`;
  }

  /**
   * Converts a wildcard pattern to a RegExp.
   * Supports:
   *   user.*      → matches user.created, user.deleted
   *   order.**.paid → matches order.item.paid, order.item.a.b.paid
   *   exact.event → matches only exact.event
   */
  _patternToRegex(pattern) {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex special chars (including dots)
      .replace(/\\\.\\\*/g, '\\.[^.]+')       // \.\* → \.one-segment
      .replace(/\*\*/g, '.+')                 // ** → any (multi-segment)
      .replace(/(?<!\[)\*/g, '[^.]+');        // remaining * → single segment
    return new RegExp(`^${escaped}$`);
  }

  /** Returns all subscriptions whose pattern matches the given event name. */
  _matchingSubscriptions(event) {
    const matched = [];
    for (const [, subs] of this._subscriptions) {
      for (const sub of subs) {
        if (sub._regex.test(event)) {
          matched.push(sub);
        }
      }
    }
    // Sort descending by priority
    matched.sort((a, b) => b.priority - a.priority);
    return matched;
  }

  _addToHistory(event, payload) {
    if (this._historySize <= 0) return;
    this._history.push({ event, payload, timestamp: Date.now() });
    if (this._history.length > this._historySize) {
      this._history.shift();
    }
  }

  async _invokeWithRetry(sub, event, payload) {
    let attempt = 0;
    let lastError;

    while (attempt <= sub.maxRetries) {
      try {
        await Promise.resolve(sub.handler(payload, { event, subscriptionId: sub.id }));
        return true; // success
      } catch (err) {
        lastError = err;
        attempt++;
        if (attempt <= sub.maxRetries) {
          const delay = sub.retryBaseMs * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    // All retries exhausted → dead letter
    this._deadLetterQueue.push({
      event,
      payload,
      subscriptionId: sub.id,
      pattern: sub.pattern,
      lastError,
      attempts: attempt,
      timestamp: Date.now(),
    });

    if (this._onError) {
      try { this._onError(lastError, event, sub.id); } catch (_) {}
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to an event or wildcard pattern.
   *
   * @param {string}   pattern
   * @param {Function} handler
   * @param {object}   [options]
   * @param {boolean}  [options.once=false]
   * @param {number}   [options.priority=0]
   * @param {number}   [options.maxRetries=3]
   * @param {number}   [options.retryBaseMs=100]
   * @returns {string} subscription id (use to unsubscribe)
   */
  on(pattern, handler, options = {}) {
    if (typeof pattern !== 'string' || !pattern) throw new TypeError('pattern must be a non-empty string');
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');

    const totalListeners = [...this._byId.values()].filter(s => s.pattern === pattern).length;
    if (totalListeners >= this._maxListeners) {
      console.warn(`[EventBus] Possible listener leak: ${totalListeners + 1} listeners for pattern "${pattern}"`);
    }

    const sub = {
      id: this._nextId(),
      pattern,
      handler,
      once: options.once ?? false,
      priority: options.priority ?? 0,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      retryBaseMs: options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
      _regex: this._patternToRegex(pattern),
    };

    if (!this._subscriptions.has(pattern)) {
      this._subscriptions.set(pattern, []);
    }
    this._subscriptions.get(pattern).push(sub);
    this._byId.set(sub.id, sub);

    return sub.id;
  }

  /**
   * Subscribe for exactly one emission, then auto-unsubscribe.
   * @param {string}   pattern
   * @param {Function} handler
   * @param {object}   [options]
   * @returns {string} subscription id
   */
  once(pattern, handler, options = {}) {
    return this.on(pattern, handler, { ...options, once: true });
  }

  /**
   * Unsubscribe by subscription id.
   * @param {string} id
   * @returns {boolean} true if found and removed
   */
  off(id) {
    const sub = this._byId.get(id);
    if (!sub) return false;

    this._byId.delete(id);
    const list = this._subscriptions.get(sub.pattern);
    if (list) {
      const idx = list.findIndex((s) => s.id === id);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) this._subscriptions.delete(sub.pattern);
    }
    return true;
  }

  /**
   * Emit an event, invoking all matching handlers (with retry logic).
   * Returns a promise that resolves when all handlers finish.
   *
   * @param {string} event
   * @param {*}      [payload]
   * @returns {Promise<EmitResult>}
   */
  async emit(event, payload) {
    if (typeof event !== 'string' || !event) throw new TypeError('event must be a non-empty string');

    this._addToHistory(event, payload);

    const subs = this._matchingSubscriptions(event);
    if (subs.length === 0) return { event, handlersInvoked: 0, errors: 0 };

    let errors = 0;
    const onceIds = [];

    await Promise.all(
      subs.map(async (sub) => {
        if (sub.once) onceIds.push(sub.id);
        const ok = await this._invokeWithRetry(sub, event, payload);
        if (!ok) errors++;
      })
    );

    // Remove once-subscriptions after emit
    for (const id of onceIds) this.off(id);

    return { event, handlersInvoked: subs.length, errors };
  }

  /**
   * Emit an event synchronously (no retry, no async handlers).
   * Useful for hot paths. Throws if any handler throws.
   *
   * @param {string} event
   * @param {*}      [payload]
   * @returns {number} handlers invoked
   */
  emitSync(event, payload) {
    if (typeof event !== 'string' || !event) throw new TypeError('event must be a non-empty string');

    this._addToHistory(event, payload);

    const subs = this._matchingSubscriptions(event);
    const onceIds = [];

    for (const sub of subs) {
      if (sub.once) onceIds.push(sub.id);
      sub.handler(payload, { event, subscriptionId: sub.id });
    }

    for (const id of onceIds) this.off(id);
    return subs.length;
  }

  /**
   * Remove all subscriptions for a given pattern (or all if no pattern given).
   * @param {string} [pattern]
   */
  clear(pattern) {
    if (pattern) {
      const list = this._subscriptions.get(pattern) ?? [];
      for (const sub of list) this._byId.delete(sub.id);
      this._subscriptions.delete(pattern);
    } else {
      this._subscriptions.clear();
      this._byId.clear();
    }
  }

  /** Returns current event history (requires historySize > 0 in constructor). */
  getHistory(filter) {
    if (!filter) return [...this._history];
    return this._history.filter((h) => h.event === filter || h.event.startsWith(filter));
  }

  /** Returns a copy of the dead-letter queue. */
  getDeadLetters() {
    return [...this._deadLetterQueue];
  }

  /** Clear the dead-letter queue. */
  clearDeadLetters() {
    this._deadLetterQueue = [];
  }

  /** Returns the number of active subscriptions. */
  get listenerCount() {
    return this._byId.size;
  }

  /** Returns all currently registered patterns. */
  get patterns() {
    return [...this._subscriptions.keys()];
  }
}

module.exports = { EventBus };
