// Live updates over Server-Sent Events (ARCHITECTURE.md §7.1).
//
// The browser's EventSource reconnects by itself after a dropped connection
// (the server sends `retry: 3000`) but gives up for good when a reconnect is
// answered with an error status (e.g. 429 while the per-IP limit is reached);
// then we reopen with exponential backoff. Events sent while disconnected are
// lost, so every `hello` (first connect and each reconnect) calls `onHello`,
// which the page uses to refetch a snapshot. While reopening is backing off
// (e.g. every fan on the school's Wi-Fi shares one address and the stream
// limit is reached) `onPoll` is called every POLL_MS instead, so the page
// keeps refetching the snapshot rather than freezing.

import { noteServerTime } from './clock.js';

const MAX_BACKOFF_MS = 30_000;
// Phones freeze background tabs and may keep a dead socket that never
// errors; after this long hidden, reconnect as soon as the page is visible.
const HIDDEN_RECONNECT_MS = 30_000;
// The iOS app polls at the same interval when its stream is down.
const POLL_MS = 15_000;

export function connectStream({ gameId = null, onHello, onGame, onRemoved, onState, onPoll } = {}) {
  const url = gameId === null ? '/api/stream' : `/api/stream?game=${encodeURIComponent(gameId)}`;
  let source = null;
  let state = null;
  let failures = 0;
  let retryTimer = null;
  let pollTimer = null;
  let hiddenAt = null;
  let closed = false;

  const setState = (next) => {
    if (next === state) return;
    state = next;
    onState?.(next);
  };

  const parse = (event) => {
    try {
      const data = JSON.parse(event.data);
      noteServerTime(data.serverTime);
      return data;
    } catch {
      return null;
    }
  };

  function open() {
    clearTimeout(retryTimer);
    retryTimer = null;
    source?.close();
    source = null;
    if (navigator.onLine === false) {
      setState('offline');
      return;
    }
    setState(state === null ? 'connecting' : 'reconnecting');

    const es = new EventSource(url);
    source = es;
    es.addEventListener('hello', (event) => {
      if (source !== es) return;
      parse(event);
      failures = 0;
      stopPolling();
      setState('open');
      onHello?.();
    });
    es.addEventListener('game', (event) => {
      if (source !== es) return;
      const data = parse(event);
      if (data?.game) onGame?.(data.game);
    });
    es.addEventListener('removed', (event) => {
      if (source !== es) return;
      const data = parse(event);
      if (data?.id) onRemoved?.(data.id);
    });
    es.addEventListener('error', () => {
      if (source !== es || closed) return;
      if (es.readyState === EventSource.CLOSED) scheduleRetry();
      else setState(navigator.onLine === false ? 'offline' : 'reconnecting');
    });
  }

  function scheduleRetry() {
    source?.close();
    source = null;
    failures += 1;
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures - 1, 5));
    setState(navigator.onLine === false ? 'offline' : 'reconnecting');
    retryTimer = setTimeout(open, base * (0.75 + Math.random() * 0.5));
    startPolling();
  }

  // Hidden pages and offline devices skip their turn.
  function startPolling() {
    if (!onPoll || pollTimer !== null) return;
    pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine !== false) onPoll();
    }, POLL_MS);
  }

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  const restart = () => {
    if (!closed) open();
  };
  const onOnline = () => restart();
  const onOffline = () => setState('offline');
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    if (away >= HIDDEN_RECONNECT_MS || state !== 'open') restart();
  };
  const onPageShow = (event) => {
    if (event.persisted) restart();
  };

  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  window.addEventListener('pageshow', onPageShow);
  document.addEventListener('visibilitychange', onVisibility);
  open();

  return {
    restart,
    close() {
      closed = true;
      clearTimeout(retryTimer);
      stopPolling();
      source?.close();
      source = null;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
