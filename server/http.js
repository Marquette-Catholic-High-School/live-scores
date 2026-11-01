// HTTP layer: a small router for /api/*, JSON bodies, error mapping, auth +
// CSRF enforcement, rate limits, client IP behind Caddy or a Cloudflare Tunnel,
// HTTPS enforcement, security headers and static files from public/
// (ARCHITECTURE.md §7, §10).

import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pipeline } from 'node:stream/promises';
import { clearedSessionCookie, passesCsrfCheck, sessionCookie } from './auth.js';
import { HttpError, badRequest, forbidden, notFound, rateLimited, unauthorized } from './errors.js';
import { rateLimitKey } from './ratelimit.js';
import { isPlainObject } from './validate.js';

export const MAX_BODY_BYTES = 64 * 1024;

export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
});

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
});

const CLEAN_ROUTES = new Map([
  ['/', 'index.html'],
  ['/login', 'login.html'],
  ['/keeper', 'keeper.html'],
  ['/admin', 'admin.html'],
]);
const GAME_PAGE_ROUTE = /^\/game\/[^/]+$/;

const FALLBACK_404 =
  '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>Not found</title></head><body><h1>Page not found</h1><p><a href="/">Back to scores</a></p></body></html>\n';

// ---- router -------------------------------------------------------------------

export class Router {
  #routes = [];

  // options.auth: 'none' | 'optional' | 'user' | 'admin'
  // options.limiter: RateLimiter applied per client (rate-limit key)
  // options.raw: handler writes the response itself (SSE)
  add(method, pattern, handler, options = {}) {
    const keys = [];
    const source = pattern.replace(/:([A-Za-z]+)/g, (_match, key) => {
      keys.push(key);
      return '([^/]+)';
    });
    this.#routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler, auth: 'none', ...options });
    return this;
  }

  get(pattern, handler, options) {
    return this.add('GET', pattern, handler, options);
  }

  post(pattern, handler, options) {
    return this.add('POST', pattern, handler, options);
  }

  patch(pattern, handler, options) {
    return this.add('PATCH', pattern, handler, options);
  }

  delete(pattern, handler, options) {
    return this.add('DELETE', pattern, handler, options);
  }

  match(method, pathname) {
    const wanted = method === 'HEAD' ? 'GET' : method;
    for (const route of this.#routes) {
      if (route.method !== wanted || (method === 'HEAD' && route.raw)) continue;
      const match = route.regex.exec(pathname);
      if (!match) continue;
      const params = {};
      route.keys.forEach((key, index) => {
        try {
          params[key] = decodeURIComponent(match[index + 1]);
        } catch {
          throw badRequest('Malformed URL.');
        }
      });
      return { route, params };
    }
    return null;
  }
}

// ---- request helpers ------------------------------------------------------------

function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  let ip = value.trim();
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
  if (ip.toLowerCase().startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  return net.isIP(ip) ? ip : null;
}

function isLoopback(ip) {
  return ip !== null && (ip === '::1' || ip.startsWith('127.'));
}

function fromTrustedProxy(req, trustProxy) {
  return trustProxy && isLoopback(normalizeIp(req.socket.remoteAddress));
}

// Behind Caddy or a Cloudflare Tunnel the peer is loopback and the client is
// the last X-Forwarded-For hop: Caddy discards untrusted incoming values, and
// Cloudflare appends the address that connected to it (cloudflared passes the
// header on unchanged).
export function clientIp(req, trustProxy) {
  const remote = normalizeIp(req.socket.remoteAddress);
  if (trustProxy && isLoopback(remote)) {
    const header = req.headers['x-forwarded-for'];
    if (typeof header === 'string') {
      const hops = header.split(',').map((hop) => hop.trim()).filter(Boolean);
      const last = normalizeIp(hops.at(-1));
      if (last) return last;
    }
  }
  return remote ?? 'unknown';
}

function forwardedProto(req, trustProxy) {
  if (!fromTrustedProxy(req, trustProxy)) return null;
  const proto = req.headers['x-forwarded-proto'];
  return typeof proto === 'string' ? proto.split(',')[0].trim().toLowerCase() : null;
}

export function isHttpsRequest(req, trustProxy) {
  return Boolean(req.socket.encrypted) || forwardedProto(req, trustProxy) === 'https';
}

// Caddy redirects plain HTTP itself, but a Cloudflare Tunnel also forwards
// http:// visits unless the zone has "Always Use HTTPS" on. The proxy says so
// in X-Forwarded-Proto.
export function arrivedOverPlainHttp(req, trustProxy) {
  return forwardedProto(req, trustProxy) === 'http';
}

function readJsonBody(req, res) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      res.setHeader('Connection', 'close');
      req.resume();
      reject(badRequest('Request body exceeds 64 KB.'));
      return;
    }
    const chunks = [];
    let total = 0;
    let failed = false;
    const onData = (chunk) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        res.setHeader('Connection', 'close');
        reject(badRequest('Request body exceeds 64 KB.'));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('error', (err) => {
      if (!failed) reject(err);
      failed = true;
    });
    req.on('end', () => {
      if (failed) return;
      if (total === 0) {
        resolve({});
        return;
      }
      const type = req.headers['content-type'];
      if (typeof type !== 'string' || !/^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i.test(type)) {
        reject(badRequest('Content-Type must be application/json.'));
        return;
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reject(badRequest('Malformed JSON body.'));
        return;
      }
      if (!isPlainObject(body)) {
        reject(badRequest('Request body must be a JSON object.'));
        return;
      }
      resolve(body);
    });
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function sendText(res, status, text) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

// ---- static files -----------------------------------------------------------------

async function resolveStaticFile(publicDir, pathname) {
  const clean = CLEAN_ROUTES.get(pathname) ?? (GAME_PAGE_ROUTE.test(pathname) ? 'game.html' : null);
  let relative = clean;
  if (!relative) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return { status: 400 };
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return { status: 400 };
    const segments = decoded.split('/').filter(Boolean);
    // No dotfiles, no "." / ".." segments: traversal attempts simply 404.
    if (segments.length === 0 || segments.some((segment) => segment.startsWith('.'))) return { status: 404 };
    relative = segments.join('/');
  }

  let root;
  try {
    root = await realpath(publicDir);
  } catch {
    return { status: 404 };
  }
  const candidate = path.resolve(root, relative);
  if (!candidate.startsWith(root + path.sep)) return { status: 404 };
  try {
    const real = await realpath(candidate);
    if (!real.startsWith(root + path.sep)) return { status: 404 };
    const info = await stat(real);
    if (!info.isFile()) return { status: 404 };
    return { status: 200, file: real, info };
  } catch {
    return { status: 404 };
  }
}

async function sendNotFoundPage(req, res, publicDir) {
  let body = FALLBACK_404;
  try {
    const root = await realpath(publicDir);
    body = await readFile(path.join(root, '404.html'), 'utf8');
  } catch {
    // public/404.html is optional.
  }
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function serveStatic(req, res, url, publicDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    sendText(res, 405, 'Method Not Allowed\n');
    return;
  }
  const resolved = await resolveStaticFile(publicDir, url.pathname);
  if (resolved.status === 400) {
    sendText(res, 400, 'Bad Request\n');
    return;
  }
  if (resolved.status !== 200) {
    await sendNotFoundPage(req, res, publicDir);
    return;
  }

  const { file, info } = resolved;
  const extension = path.extname(file).toLowerCase();
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  res.setHeader('Content-Type', MIME_TYPES[extension] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', extension === '.html' ? 'no-cache' : 'public, max-age=300');
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', info.mtime.toUTCString());
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Length', info.size);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await pipeline(createReadStream(file), res);
}

// ---- server ---------------------------------------------------------------------

export function createHttpServer({ config, log, router, auth, now = Date.now, globalLimiter }) {
  const publicDir = config.publicDir;
  const httpsOrigin = config.publicUrl.startsWith('https://') ? new URL(config.publicUrl).origin : null;

  async function handleApi(req, res, url, ip, https) {
    res.setHeader('Cache-Control', 'no-store');
    const ipKey = rateLimitKey(ip);
    const match = router.match(req.method, url.pathname);
    const authenticates = Boolean(match) && match.route.auth !== 'none';
    const resolved = auth.resolve(req, { touch: authenticates });
    // Fans at a game share one NAT address; signed-in staff (any role) must
    // never be throttled by their traffic, so only anonymous requests count.
    if (resolved.status !== 'ok') {
      const limit = globalLimiter?.hit(ipKey);
      if (limit && !limit.allowed) throw rateLimited('Too many requests. Slow down.', limit.retryAfterSec);
    }

    if (!match) throw notFound('No such API endpoint.');
    const { route, params } = match;
    if (route.limiter) {
      const routeLimit = route.limiter.hit(ipKey);
      if (!routeLimit.allowed) throw rateLimited('Too many requests. Slow down.', routeLimit.retryAfterSec);
    }

    const ctx = { req, res, url, query: url.searchParams, params, ip, ipKey, https, body: {}, session: null, user: null };
    if (authenticates) {
      if (resolved.status === 'ok') {
        ctx.session = resolved;
        ctx.user = resolved.user;
        if (resolved.refreshed && resolved.via === 'cookie') {
          res.appendHeader('Set-Cookie', sessionCookie(resolved.token, { secure: https }));
        }
      } else if (resolved.status === 'invalid' && resolved.via === 'cookie') {
        res.appendHeader('Set-Cookie', clearedSessionCookie({ secure: https }));
      }
      if (route.auth === 'user' || route.auth === 'admin') {
        if (!ctx.user) throw unauthorized();
        if (!passesCsrfCheck(req, ctx.session.via)) throw forbidden('Missing X-MCHS-Client header.');
        if (route.auth === 'admin' && ctx.user.role !== 'admin') throw forbidden('Only admins can do that.');
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') ctx.body = await readJsonBody(req, res);

    const result = await route.handler(ctx);
    if (route.raw) return;
    sendJson(res, 200, { ...result, serverTime: now() });
  }

  function sendError(res, err, req) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof HttpError) {
      if (err.retryAfterSec) res.setHeader('Retry-After', String(err.retryAfterSec));
      sendJson(res, err.status, { error: { code: err.code, message: err.message }, serverTime: now() });
      return;
    }
    log.error('request failed', { method: req.method, path: req.url, err });
    sendJson(res, 500, { error: { code: 'internal', message: 'Something went wrong on the server.' }, serverTime: now() });
  }

  async function handle(req, res) {
    const started = performance.now();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    const ip = clientIp(req, config.trustProxy);
    const https = isHttpsRequest(req, config.trustProxy);
    if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendText(res, 400, 'Bad Request\n');
      return;
    }
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');

    res.on('finish', () => {
      const fields = { method: req.method, path: url.pathname, status: res.statusCode, ms: Math.round(performance.now() - started), ip };
      if (res.statusCode >= 500) log.error('request', fields);
      else if (isApi && req.method !== 'GET' && req.method !== 'HEAD') log.info('request', fields);
      else log.debug('request', fields);
    });

    try {
      // Never serve the portal or accept a password over plain HTTP when the
      // server has an https:// address: pages move to HTTPS, anything else is refused.
      if (httpsOrigin && arrivedOverPlainHttp(req, config.trustProxy)) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw forbidden('Use https:// to reach this server.');
        res.statusCode = 308;
        res.setHeader('Location', `${httpsOrigin}${url.pathname}${url.search}`);
        res.setHeader('Content-Length', 0);
        res.end();
        return;
      }
      if (isApi) await handleApi(req, res, url, ip, https);
      else await serveStatic(req, res, url, publicDir);
    } catch (err) {
      sendError(res, err, req);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error('unhandled request error', { err });
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'internal', message: 'Something went wrong on the server.' }, serverTime: now() });
      else res.destroy();
    });
  });
  // Caddy keeps upstream connections alive for up to 2 minutes; outlive that
  // so Node never closes a connection Caddy is about to reuse.
  server.keepAliveTimeout = 125_000;
  server.headersTimeout = 130_000;
  server.requestTimeout = 135_000;
  return server;
}
