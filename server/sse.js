// Server-Sent Events hub for GET /api/stream (ARCHITECTURE.md §7.1).

import { rateLimited } from './errors.js';

const MAX_BUFFERED_BYTES = 1024 * 1024;

// JSON.stringify leaves U+0085, U+2028 and U+2029 unescaped, but some line
// readers (Swift's AsyncLineSequence, which the iOS app uses) split on them,
// which would cut one `data:` line in two. Escaping keeps it valid JSON.
const UNICODE_LINE_BREAKS = /[\u0085\u2028\u2029]/g;

function eventData(value) {
  return JSON.stringify(value).replace(UNICODE_LINE_BREAKS, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export class SseHub {
  #clients = new Set();
  #perIp = new Map();
  #pingTimer = null;
  #now;
  #log;
  #maxPerIp;
  #maxTotal;
  #pingIntervalMs;
  #isSessionValid;
  #closed = false;

  // `isSessionValid(sessionId)` re-checks signed-in viewers on every ping, so
  // a stream stops getting staff-only fields soon after sign-out or revocation.
  constructor({ now = Date.now, log, maxPerIp = 2000, maxTotal = 20_000, pingIntervalMs = 25_000, isSessionValid = null } = {}) {
    this.#now = now;
    this.#log = log;
    this.#maxPerIp = maxPerIp;
    this.#maxTotal = maxTotal;
    this.#pingIntervalMs = pingIntervalMs;
    this.#isSessionValid = isSessionValid;
  }

  get size() {
    return this.#clients.size;
  }

  // Takes over `res`. Throws a 429 HttpError (before any byte is written)
  // when the per-client or total limit is reached. `ip` is the client's
  // rate-limit key.
  open(req, res, { ip, gameId = null, authenticated = false, sessionId = null }) {
    if (this.#closed) throw rateLimited('The server is shutting down.', 5);
    if (this.#clients.size >= this.#maxTotal) throw rateLimited('Too many live connections. Try again shortly.', 30);
    if ((this.#perIp.get(ip) ?? 0) >= this.#maxPerIp) throw rateLimited('Too many live connections from your network.', 30);

    const client = { res, ip, gameId, authenticated: authenticated && sessionId !== null, sessionId };
    this.#clients.add(client);
    this.#perIp.set(ip, (this.#perIp.get(ip) ?? 0) + 1);

    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    req.socket.setTimeout(0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    const remove = () => this.#remove(client);
    res.on('close', remove);
    res.on('error', remove);

    this.#write(client, `retry: 3000\n\nevent: hello\ndata: ${eventData({ serverTime: this.#now() })}\n\n`);
    this.#ensurePing();
    return client;
  }

  #remove(client) {
    if (!this.#clients.delete(client)) return;
    const count = (this.#perIp.get(client.ip) ?? 1) - 1;
    if (count <= 0) this.#perIp.delete(client.ip);
    else this.#perIp.set(client.ip, count);
    if (this.#clients.size === 0 && this.#pingTimer) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
  }

  #write(client, chunk) {
    const { res } = client;
    if (res.destroyed || res.writableEnded) {
      this.#remove(client);
      return;
    }
    res.write(chunk);
    // A client that stops reading must not make us buffer without bound.
    if (res.writableLength > MAX_BUFFERED_BYTES) {
      this.#log?.warn('dropping slow SSE client', { ip: client.ip, buffered: res.writableLength });
      res.destroy();
      this.#remove(client);
    }
  }

  #ensurePing() {
    if (this.#pingTimer) return;
    this.#pingTimer = setInterval(() => {
      for (const client of [...this.#clients]) {
        if (client.authenticated && this.#isSessionValid && !this.#sessionStillValid(client.sessionId)) {
          client.authenticated = false;
        }
        this.#write(client, ': ping\n\n');
      }
    }, this.#pingIntervalMs);
    this.#pingTimer.unref();
  }

  #sessionStillValid(sessionId) {
    try {
      return this.#isSessionValid(sessionId);
    } catch (err) {
      this.#log?.warn('could not re-check an SSE session', { err: err.message });
      return true;
    }
  }

  // `serialize(authenticated)` returns the Game JSON for that kind of viewer;
  // each variant is built at most once per event.
  publishGame(gameId, serialize) {
    if (this.#clients.size === 0) return;
    const frames = new Map();
    const frame = (authenticated) => {
      if (!frames.has(authenticated)) {
        const data = eventData({ serverTime: this.#now(), game: serialize(authenticated) });
        frames.set(authenticated, `event: game\ndata: ${data}\n\n`);
      }
      return frames.get(authenticated);
    };
    for (const client of [...this.#clients]) {
      if (client.gameId !== null && client.gameId !== gameId) continue;
      this.#write(client, frame(client.authenticated));
    }
  }

  publishRemoved(gameId) {
    if (this.#clients.size === 0) return;
    const chunk = `event: removed\ndata: ${eventData({ serverTime: this.#now(), id: gameId })}\n\n`;
    for (const client of [...this.#clients]) {
      if (client.gameId !== null && client.gameId !== gameId) continue;
      this.#write(client, chunk);
    }
  }

  closeAll() {
    this.#closed = true;
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
    for (const client of [...this.#clients]) {
      client.res.end();
      this.#remove(client);
    }
  }
}
