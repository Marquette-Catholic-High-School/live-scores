// Fetch wrapper for the MCHS Live API (ARCHITECTURE.md §7).
//
// Always sends `X-MCHS-Client: web` (cookie-authenticated writes are rejected
// without it), parses `{ error: { code, message } }` into ApiError, and feeds
// every response's `serverTime` to the clock so running clocks stay in sync.

import { noteServerTime } from './clock.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  constructor({ status, code, message, retryAfterSec = null }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }

  // Safe to resend unchanged: the request may never have reached the server
  // (no network, timeout, proxy error while the server restarts) or was
  // throttled.
  get transient() {
    return this.status === 0 || this.status === 429 || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

function fallbackCode(status) {
  switch (status) {
    case 400: return 'bad_request';
    case 401: return 'unauthorized';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 409: return 'conflict';
    case 429: return 'rate_limited';
    default: return status >= 500 ? 'internal' : 'http_error';
  }
}

function fallbackMessage(status) {
  if (status === 401) return 'Please sign in.';
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status === 502 || status === 503 || status === 504) return 'The server is unavailable right now. Retrying…';
  if (status >= 500) return 'Something went wrong on the server.';
  return `The request failed (HTTP ${status}).`;
}

export async function api(path, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const headers = { Accept: 'application/json', 'X-MCHS-Client': 'web' };
  const init = { method, headers, credentials: 'same-origin', cache: 'no-store' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
  }
  init.signal = controller.signal;

  let response;
  let text;
  const sentAt = Date.now();
  try {
    response = await fetch(path, init);
    text = await response.text();
  } catch (err) {
    if (signal?.aborted && !timedOut) throw err;
    throw new ApiError({
      status: 0,
      code: timedOut ? 'timeout' : 'network',
      message: timedOut ? 'The server took too long to answer.' : 'Can’t reach the server. Check your connection.',
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }

  const receivedAt = Date.now();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (data && typeof data.serverTime === 'number') noteServerTime(data.serverTime, receivedAt, sentAt);

  if (!response.ok) {
    const error = data && typeof data.error === 'object' ? data.error : null;
    const retryAfter = Number.parseInt(response.headers.get('Retry-After') ?? '', 10);
    throw new ApiError({
      status: response.status,
      code: typeof error?.code === 'string' ? error.code : fallbackCode(response.status),
      message: typeof error?.message === 'string' ? error.message : fallbackMessage(response.status),
      retryAfterSec: Number.isFinite(retryAfter) ? retryAfter : null,
    });
  }
  if (!data || typeof data !== 'object') {
    throw new ApiError({ status: response.status, code: 'bad_response', message: 'The server sent an unexpected response.' });
  }
  return data;
}

export function gameApiPath(id, suffix = '') {
  return `/api/games/${encodeURIComponent(id)}${suffix}`;
}

// The signed-in user, or null when nobody is signed in.
export async function fetchSession() {
  try {
    const { user } = await api('/api/auth/me');
    return user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export function loginUrl(next = `${location.pathname}${location.search}${location.hash}`) {
  return `/login?next=${encodeURIComponent(next)}`;
}

let configPromise = null;

// GET /api/config, fetched once per page.
export function fetchConfig() {
  configPromise ??= api('/api/config').catch((err) => {
    configPromise = null;
    throw err;
  });
  return configPromise;
}
