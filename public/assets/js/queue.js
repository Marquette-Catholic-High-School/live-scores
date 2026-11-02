// Scoring actions (POST /api/games/:id/actions) are sent strictly in order,
// one at a time. Each user intent gets one actionId that is reused on every
// retry: if a request reached the server but its answer was lost, the retry
// returns `duplicate: true` instead of scoring twice (ARCHITECTURE.md §7).

import { ApiError, api, gameApiPath } from './api.js';

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 10_000;
const SERVER_ERROR_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 10_000;

// crypto.randomUUID needs a secure context (HTTPS or localhost); fall back
// to an equivalent v4 UUID from getRandomValues when opened over plain HTTP.
export function newActionId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function backoff(attempt) {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

const defaultSend = (item) =>
  api(gameApiPath(item.gameId, '/actions'), { method: 'POST', body: item.body, timeoutMs: REQUEST_TIMEOUT_MS });

// Refused actions that later taps don't build on: after one of these is
// refused (409), the rest of the queue is still sent.
const INDEPENDENT_TYPES = new Set(['score', 'set_score', 'clock', 'note']);

export class ActionQueue {
  #items = [];
  #busy = false;
  #timer = null;
  #status = 'idle'; // idle | sending | retrying | offline | blocked
  #lastError = null;
  #listeners = new Set();
  #send;
  #onApplied;
  #onRejected;
  #online;
  #persist;

  // onApplied(result, item): the server accepted (or had already applied) it.
  // onRejected(error, item, droppedCount): refused for good; later queued
  // actions for that game that assumed this one were discarded too.
  // persist(items): called with [{ gameId, body, meta }] whenever the waiting
  // actions change, so a page can keep them across a reload (see restore).
  constructor({ send = defaultSend, onApplied, onRejected, isOnline = () => navigator.onLine !== false, persist } = {}) {
    this.#send = send;
    this.#onApplied = onApplied;
    this.#onRejected = onRejected;
    this.#online = isOnline;
    this.#persist = persist;
  }

  get status() {
    return this.#status;
  }

  get lastError() {
    return this.#lastError;
  }

  get size() {
    return this.#items.length;
  }

  pendingFor(gameId) {
    return this.#items.filter((item) => item.gameId === gameId);
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify() {
    for (const listener of [...this.#listeners]) listener(this);
  }

  #setStatus(status, error = this.#lastError) {
    this.#status = status;
    this.#lastError = error;
    this.#notify();
  }

  #saveItems() {
    this.#report(this.#persist, this.#items.map(({ gameId, body, meta }) => ({ gameId, body, meta })));
  }

  #added() {
    this.#saveItems();
    if (this.#status === 'idle') this.#setStatus('sending', null);
    else this.#notify();
    this.#pump();
  }

  // meta: client-side facts about the tap (never sent). next: send it before
  // everything already waiting (a follow-up to the action just applied).
  enqueue(gameId, action, { meta = null, next = false } = {}) {
    const item = { gameId, body: { actionId: newActionId(), ...action }, meta, attempts: 0 };
    // Never ahead of a request already in flight.
    if (next) this.#items.splice(this.#busy ? 1 : 0, 0, item);
    else this.#items.push(item);
    this.#added();
    return item;
  }

  // Re-queues actions saved by `persist` before a reload, keeping their
  // actionIds so any the server already applied are not applied twice.
  // Returns how many were added.
  restore(saved) {
    const queued = new Set(this.#items.map((item) => item.body.actionId));
    let added = 0;
    for (const entry of Array.isArray(saved) ? saved : []) {
      const actionId = entry?.body?.actionId;
      if (typeof entry?.gameId !== 'string' || typeof actionId !== 'string' || typeof entry.body.type !== 'string' || queued.has(actionId)) continue;
      queued.add(actionId);
      this.#items.push({ gameId: entry.gameId, body: entry.body, meta: entry.meta ?? null, attempts: 0 });
      added += 1;
    }
    if (added) this.#added();
    return added;
  }

  // Retry immediately (back online, "Retry" tapped, signed in again).
  retryNow() {
    clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#status === 'blocked' || this.#status === 'retrying' || this.#status === 'offline') {
      this.#setStatus(this.#items.length ? 'sending' : 'idle');
    }
    this.#pump();
  }

  #retryLater(delayMs, status, error) {
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#pump();
    }, delayMs);
    this.#setStatus(status, error);
  }

  async #pump() {
    while (!this.#busy && this.#timer === null && this.#status !== 'blocked') {
      const item = this.#items[0];
      if (!item) {
        if (this.#status !== 'idle') this.#setStatus('idle', null);
        return;
      }
      this.#busy = true;
      let result;
      try {
        result = await this.#send(item);
      } catch (err) {
        this.#busy = false;
        const error = err instanceof ApiError ? err : new ApiError({ status: 0, code: 'client', message: String(err?.message ?? err) });
        if (error.transient) {
          item.attempts += 1;
          const delay = error.status === 429 && error.retryAfterSec ? error.retryAfterSec * 1000 : backoff(item.attempts);
          this.#retryLater(delay, this.#online() ? 'retrying' : 'offline', error);
          return;
        }
        if (error.status === 401) {
          // Signed out (session expired or revoked): keep everything queued
          // until the user signs in again and taps Retry.
          this.#setStatus('blocked', error);
          return;
        }
        if (error.status >= 500 && item.attempts < SERVER_ERROR_RETRIES) {
          item.attempts += 1;
          this.#retryLater(backoff(item.attempts), 'retrying', error);
          return;
        }
        // Later actions for the game are discarded when they built on this
        // one: after a refused period/outs change or undo they would land in
        // the wrong period or revert the wrong change, and after any other
        // refusal (no longer the holder, bad request) they would fail alike.
        // After a refused score, correction, clock or note change only an
        // undo right behind it goes too — it was meant to revert this one.
        // A refusal because the scoreboard drives the game (ARCHITECTURE.md
        // §11) discards nothing else: the server refuses each later scoring
        // action on its own, and notes still go through.
        const later = this.#items.filter((other) => other !== item && other.gameId === item.gameId);
        let discard = later;
        if (error.code === 'scoreboard_active') discard = [];
        else if (error.status === 409 && INDEPENDENT_TYPES.has(item.body.type)) discard = later[0]?.body.type === 'undo' ? [later[0]] : [];
        this.#items = this.#items.filter((other) => other !== item && !discard.includes(other));
        this.#saveItems();
        this.#setStatus(this.#items.length ? 'sending' : 'idle', null);
        this.#report(this.#onRejected, error, item, discard.length);
        continue;
      }
      this.#busy = false;
      this.#items.shift();
      this.#saveItems();
      // Hand over the new game state before listeners drop the pending overlay.
      this.#report(this.#onApplied, result, item);
      this.#setStatus(this.#items.length ? 'sending' : 'idle', null);
    }
  }

  // A failing page callback must not stall the queue.
  #report(callback, ...args) {
    try {
      callback?.(...args);
    } catch (err) {
      console.error('action queue callback failed', err);
    }
  }
}
