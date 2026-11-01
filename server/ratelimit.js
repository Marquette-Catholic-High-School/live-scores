// Fixed-window in-memory counters. A single process serves everything, so
// no shared store is needed; limits reset on restart, which is acceptable.

import net from 'node:net';

// The key a client is counted under. An IPv6 host usually controls a whole
// /64 and can pick a new source address per request, so IPv6 addresses are
// counted per /64; IPv4 addresses as they are.
export function rateLimitKey(ip) {
  if (typeof ip !== 'string') return 'unknown';
  const address = ip.split('%')[0];
  if (!net.isIPv6(address)) return ip;
  const [head, tail = null] = address.split('::');
  const groups = (part) => (part ? part.split(':').flatMap((group) => (group.includes('.') ? ['0', '0'] : [group])) : []);
  const front = groups(head);
  const back = tail === null ? [] : groups(tail);
  const all = [...front, ...Array(8 - front.length - back.length).fill('0'), ...back];
  return `${all.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(':')}::/64`;
}

export class RateLimiter {
  #windows = new Map();
  #now;
  #lastPrune = 0;

  constructor({ limit, windowMs, now = Date.now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.#now = now;
  }

  #window(key, now) {
    let window = this.#windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + this.windowMs };
      this.#windows.set(key, window);
    }
    return window;
  }

  #prune(now) {
    if (now - this.#lastPrune < this.windowMs) return;
    this.#lastPrune = now;
    for (const [key, window] of this.#windows) {
      if (window.resetAt <= now) this.#windows.delete(key);
    }
  }

  // Counts one hit. Returns { allowed, retryAfterSec }.
  hit(key) {
    const now = this.#now();
    this.#prune(now);
    const window = this.#window(key, now);
    window.count += 1;
    return { allowed: window.count <= this.limit, retryAfterSec: Math.ceil((window.resetAt - now) / 1000) };
  }

  // True when the key has used up its allowance (without counting a hit).
  exhausted(key) {
    const now = this.#now();
    const window = this.#windows.get(key);
    if (!window || window.resetAt <= now) return { exhausted: false, retryAfterSec: 0 };
    return { exhausted: window.count >= this.limit, retryAfterSec: Math.ceil((window.resetAt - now) / 1000) };
  }

  // Hits counted in the key's current window.
  count(key) {
    const window = this.#windows.get(key);
    return window && window.resetAt > this.#now() ? window.count : 0;
  }

  // Takes back one hit (a reserved attempt that turned out not to count).
  refund(key) {
    const window = this.#windows.get(key);
    if (window && window.count > 0) window.count -= 1;
  }

  reset(key) {
    this.#windows.delete(key);
  }

  clear() {
    this.#windows.clear();
  }
}
