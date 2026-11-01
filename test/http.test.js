import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startTestApp } from './helpers.js';

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

function assertSecurityHeaders(headers) {
  const get = (name) => (typeof headers.get === 'function' ? headers.get(name) : headers[name.toLowerCase()]);
  assert.equal(get('content-security-policy'), CSP);
  assert.equal(get('x-content-type-options'), 'nosniff');
  assert.equal(get('referrer-policy'), 'same-origin');
  assert.equal(get('x-frame-options'), 'DENY');
}

// Raw request so the path reaches the server exactly as written.
function rawGet(port, rawPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('HTTP layer and static files', () => {
  let t;
  before(async () => {
    t = await startTestApp({
      publicFiles: {
        'index.html': '<!doctype html><title>Scores</title>',
        'game.html': '<!doctype html><title>Game</title>',
        'login.html': '<!doctype html><title>Login</title>',
        'keeper.html': '<!doctype html><title>Keeper</title>',
        'admin.html': '<!doctype html><title>Admin</title>',
        'css/app.css': 'body { color: black; }',
        'js/app.js': 'export const x = 1;',
        'img/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        'manifest.webmanifest': '{}',
        '.secret': 'dotfile',
      },
    });
  });
  after(() => t.close());

  it('serves clean routes with HTML caching rules', async () => {
    const routes = { '/': 'Scores', '/game/k3j9x2m4pq': 'Game', '/login': 'Login', '/keeper': 'Keeper', '/admin': 'Admin', '/index.html': 'Scores' };
    for (const [route, title] of Object.entries(routes)) {
      const res = await fetch(t.baseUrl + route);
      assert.equal(res.status, 200, route);
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(res.headers.get('cache-control'), 'no-cache');
      assert.match(await res.text(), new RegExp(`<title>${title}</title>`));
      assertSecurityHeaders(res.headers);
    }
  });

  it('serves assets with MIME types, 5-minute caching and ETags', async () => {
    const types = { '/css/app.css': 'text/css; charset=utf-8', '/js/app.js': 'text/javascript; charset=utf-8', '/img/logo.svg': 'image/svg+xml', '/manifest.webmanifest': 'application/manifest+json; charset=utf-8' };
    for (const [route, type] of Object.entries(types)) {
      const res = await fetch(t.baseUrl + route);
      assert.equal(res.status, 200, route);
      assert.equal(res.headers.get('content-type'), type);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
      await res.arrayBuffer();
    }
    const first = await fetch(`${t.baseUrl}/css/app.css`);
    const etag = first.headers.get('etag');
    assert.ok(etag);
    await first.text();
    const cached = await fetch(`${t.baseUrl}/css/app.css`, { headers: { 'if-none-match': etag } });
    assert.equal(cached.status, 304);
    const head = await fetch(`${t.baseUrl}/js/app.js`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String('export const x = 1;'.length));
    const post = await fetch(`${t.baseUrl}/`, { method: 'POST' });
    assert.equal(post.status, 405);
  });

  it('returns a 404 page for unknown paths, directories and dotfiles', async () => {
    for (const route of ['/nope', '/css', '/css/', '/.secret', '/game/a/b', '/login/']) {
      const res = await fetch(t.baseUrl + route);
      assert.equal(res.status, 404, route);
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      assertSecurityHeaders(res.headers);
      assert.doesNotMatch(await res.text(), /dotfile/);
    }
  });

  it('blocks path traversal', async () => {
    // A file right next to public/ that must never be reachable.
    await writeFile(path.join(t.dir, 'secret.txt'), 'TOPSECRET');
    const attempts = [
      '/../secret.txt',
      '/%2e%2e/secret.txt',
      '/%2e%2e%2fsecret.txt',
      '/css/..%2f..%2fsecret.txt',
      '/css/%2e%2e/%2e%2e/secret.txt',
      '/..%5csecret.txt',
      '/....//secret.txt',
      '/../package.json',
      '/../../etc/passwd',
      '/%2e%2e/package.json',
      '/%2e%2e%2fpackage.json',
      '/css/..%2f..%2fpackage.json',
      '/css/%2e%2e/%2e%2e/package.json',
      '/..%5cpackage.json',
      '/%00index.html',
      '/%E0%A4%A',
      `/${encodeURIComponent(path.resolve(t.dir, 'data', 'live.db'))}`,
    ];
    for (const attempt of attempts) {
      const res = await rawGet(t.port, attempt);
      assert.ok(res.status === 404 || res.status === 400, `${attempt} → ${res.status}`);
      assert.doesNotMatch(res.body, /TOPSECRET|mchs-live|root:|SQLite/, attempt);
    }
  });

  it('maps API errors to JSON with serverTime', async () => {
    const missing = await fetch(`${t.baseUrl}/api/nope`);
    assert.equal(missing.status, 404);
    const body = await missing.json();
    assert.deepEqual(Object.keys(body).sort(), ['error', 'serverTime']);
    assert.equal(body.error.code, 'not_found');
    assert.equal(missing.headers.get('cache-control'), 'no-store');
    assertSecurityHeaders(missing.headers);

    const sports = await (await fetch(`${t.baseUrl}/api/sports`)).json();
    assert.equal(typeof sports.serverTime, 'number');
    assert.equal(sports.sports.basketball.id, 'basketball');
    const config = await (await fetch(`${t.baseUrl}/api/config`)).json();
    assert.deepEqual(Object.keys(config).sort(), ['apnsEnabled', 'homeTeam', 'schoolName', 'serverTime', 'startWindowMinutes', 'timeZone', 'version']);
    assert.deepEqual(config.homeTeam, { name: 'Marquette', code: 'MAR', color: '#12214D' });
    assert.equal(config.timeZone, 'America/Chicago');
    const health = await (await fetch(`${t.baseUrl}/api/health`)).json();
    assert.deepEqual(Object.keys(health).sort(), ['apns', 'db', 'ok', 'serverTime', 'sseClients', 'uptimeSec', 'version']);
    assert.equal(health.db, 'ok');
  });

  it('validates JSON bodies', async () => {
    const post = (body, type = 'application/json') =>
      fetch(`${t.baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': type }, body });
    assert.equal((await post('{nope')).status, 400);
    assert.equal((await post('[1,2]')).status, 400);
    assert.equal((await post('{"username":"a"}', 'text/plain')).status, 400);
    const big = await post(JSON.stringify({ username: 'x', password: 'y'.repeat(70 * 1024), client: 'web' }));
    assert.equal(big.status, 400);
    assert.match((await big.json()).error.message, /64 KB/);
    assert.equal((await post('{"username":"a","password":"bbbbbbbb","client":"web"}', 'application/json; charset=utf-8')).status, 401);
  });
});

describe('HTTP rate limits and proxy handling', () => {
  it('limits /api requests per client IP', async () => {
    const t = await startTestApp({ appOptions: { globalRateLimitPerMinute: 5 } });
    try {
      for (let i = 0; i < 5; i += 1) assert.equal((await fetch(`${t.baseUrl}/api/sports`, { headers: { 'x-forwarded-for': '198.51.100.1' } })).status, 200);
      const limited = await fetch(`${t.baseUrl}/api/sports`, { headers: { 'x-forwarded-for': '198.51.100.1' } });
      assert.equal(limited.status, 429);
      assert.equal((await limited.json()).error.code, 'rate_limited');
      assert.ok(Number(limited.headers.get('retry-after')) >= 1);
      assert.equal((await fetch(`${t.baseUrl}/api/sports`, { headers: { 'x-forwarded-for': '10.0.0.1, 198.51.100.2' } })).status, 200, 'the last hop is the client');
      assert.equal((await fetch(`${t.baseUrl}/`)).status, 404, 'static files are not API-limited');
    } finally {
      await t.close();
    }
  });

  it('never throttles signed-in staff for the traffic of fans behind the same NAT', async () => {
    const t = await startTestApp({ appOptions: { globalRateLimitPerMinute: 5 } });
    try {
      const nat = '203.0.113.7';
      await t.createUser('keeper', 'scorekeeper');
      await t.createUser('boss', 'admin');
      const keeper = t.client({ forwardedFor: nat });
      await keeper.loginIos('keeper');
      const web = t.client({ forwardedFor: nat });
      await web.loginWeb('boss');
      for (let i = 0; i < 5; i += 1) await t.client({ forwardedFor: nat }).get('/api/games');
      assert.equal((await t.client({ forwardedFor: nat }).get('/api/games')).status, 429, 'fans are limited');
      for (let i = 0; i < 10; i += 1) {
        assert.equal((await keeper.get('/api/games?scope=all')).status, 200, 'bearer session');
        assert.equal((await web.get('/api/auth/me')).status, 200, 'cookie session');
        assert.equal((await web.get('/api/sports')).status, 200, 'public endpoint, signed in');
      }
      const forged = t.client({ forwardedFor: nat });
      forged.token = 'A'.repeat(43);
      assert.equal((await forged.get('/api/sports')).status, 429, 'an invalid token is anonymous');
    } finally {
      await t.close();
    }
  });

  it('counts IPv6 clients per /64 and takes its defaults from the config', async () => {
    const t = await startTestApp({ env: { RATE_LIMIT_PER_MINUTE: '3' }, appOptions: { globalRateLimitPerMinute: undefined } });
    try {
      for (let i = 0; i < 3; i += 1) {
        assert.equal((await fetch(`${t.baseUrl}/api/sports`, { headers: { 'x-forwarded-for': `2001:db8:aa:bb::${i + 1}` } })).status, 200);
      }
      assert.equal((await fetch(`${t.baseUrl}/api/sports`, { headers: { 'x-forwarded-for': '2001:db8:aa:bb:1:2:3:4' } })).status, 429);
      assert.equal((await fetch(`${t.baseUrl}/api/sports`, { headers: { 'x-forwarded-for': '2001:db8:aa:bc::1' } })).status, 200);
    } finally {
      await t.close();
    }
    const defaults = await startTestApp({ appOptions: { globalRateLimitPerMinute: undefined, deviceRateLimitPerMinute: undefined } });
    try {
      assert.equal(defaults.app.limiters.global.limit, 3000);
      assert.equal(defaults.app.limiters.devices.limit, 600);
    } finally {
      await defaults.close();
    }
  });

  it('sends plain-HTTP visits from the proxy to HTTPS and adds HSTS on HTTPS', async () => {
    const t = await startTestApp({ env: { PUBLIC_URL: 'https://live.example.org/' }, publicFiles: { 'index.html': '<!doctype html><title>Scores</title>' } });
    try {
      const plain = { 'x-forwarded-proto': 'http', 'x-forwarded-for': '198.51.100.9' };
      for (const [route, location] of [
        ['/', 'https://live.example.org/'],
        ['/api/health', 'https://live.example.org/api/health'],
        ['/game/k3j9x2m4pq?from=share', 'https://live.example.org/game/k3j9x2m4pq?from=share'],
      ]) {
        const res = await fetch(t.baseUrl + route, { headers: plain, redirect: 'manual' });
        assert.equal(res.status, 308, route);
        assert.equal(res.headers.get('location'), location, route);
        assert.equal(res.headers.get('strict-transport-security'), null);
        assertSecurityHeaders(res.headers);
      }
      const head = await fetch(`${t.baseUrl}/api/health`, { method: 'HEAD', headers: plain, redirect: 'manual' });
      assert.equal(head.status, 308);
      const offsite = await rawGet(t.port, '//evil.example/steal', plain);
      assert.equal(offsite.status, 308);
      assert.equal(offsite.headers.location, 'https://live.example.org/steal', 'always our own origin');
      const login = await fetch(`${t.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { ...plain, 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'whatever1', client: 'web' }),
      });
      assert.equal(login.status, 403);
      assert.equal((await login.json()).error.code, 'forbidden');

      const secure = await fetch(`${t.baseUrl}/api/health`, { headers: { 'x-forwarded-proto': 'https' } });
      assert.equal(secure.status, 200);
      assert.equal(secure.headers.get('strict-transport-security'), 'max-age=31536000');
      await secure.arrayBuffer();
      const direct = await fetch(`${t.baseUrl}/api/health`);
      assert.equal(direct.status, 200, 'no proxy header: local checks keep working');
      assert.equal(direct.headers.get('strict-transport-security'), null);
      await direct.arrayBuffer();
    } finally {
      await t.close();
    }
  });

  it('serves plain HTTP when the public address is http:// or the proxy is not trusted', async () => {
    for (const env of [{}, { PUBLIC_URL: 'https://live.example.org', TRUST_PROXY: '0' }]) {
      const t = await startTestApp({ env });
      try {
        const res = await fetch(`${t.baseUrl}/api/health`, { headers: { 'x-forwarded-proto': 'http' }, redirect: 'manual' });
        assert.equal(res.status, 200, JSON.stringify(env));
        await res.arrayBuffer();
        const spoofed = await fetch(`${t.baseUrl}/api/health`, { headers: { 'x-forwarded-proto': 'https' } });
        assert.equal(spoofed.headers.get('strict-transport-security'), env.TRUST_PROXY === '0' ? null : 'max-age=31536000');
        await spoofed.arrayBuffer();
      } finally {
        await t.close();
      }
    }
  });

  it('ignores X-Forwarded-For when TRUST_PROXY=0', async () => {
    const t = await startTestApp({ env: { TRUST_PROXY: '0' }, appOptions: { globalRateLimitPerMinute: 2 } });
    try {
      await fetch(`${t.baseUrl}/api/sports`, { headers: { 'x-forwarded-for': '198.51.100.1' } });
      await fetch(`${t.baseUrl}/api/sports`, { headers: { 'x-forwarded-for': '198.51.100.2' } });
      assert.equal((await fetch(`${t.baseUrl}/api/sports`, { headers: { 'x-forwarded-for': '198.51.100.3' } })).status, 429);
    } finally {
      await t.close();
    }
  });

  it('serves the API when public/ does not exist', async () => {
    const t = await startTestApp({ publicDir: '/nonexistent/mchs-public' });
    try {
      assert.equal((await fetch(`${t.baseUrl}/api/health`)).status, 200);
      const page = await fetch(`${t.baseUrl}/`);
      assert.equal(page.status, 404);
      assert.match(await page.text(), /Page not found/);
    } finally {
      await t.close();
    }
  });
});
