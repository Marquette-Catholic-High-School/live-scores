import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import http2 from 'node:http2';
import { after, before, describe, it } from 'node:test';
import { ApnsClient, Http2Transport, ProviderToken } from '../server/apns.js';
import { createLogger } from '../server/log.js';
import { verifyJwt } from './helpers.js';

const log = createLogger({ level: 'silent' });

describe('APNs provider token', () => {
  it('mints an ES256 JWT, caches it and refreshes it after 50 minutes', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    let now = Date.UTC(2026, 9, 30, 12);
    const token = new ProviderToken({ key: privateKey, teamId: 'TEAM123456', keyId: 'KEY1234567', now: () => now });
    const first = token.get();
    const jwt = verifyJwt(`bearer ${first}`, publicKey);
    assert.equal(jwt.valid, true);
    assert.deepEqual(jwt.header, { alg: 'ES256', kid: 'KEY1234567' });
    assert.deepEqual(jwt.claims, { iss: 'TEAM123456', iat: now / 1000 });
    assert.equal(jwt.signatureLength, 64);

    now += 10 * 60_000;
    assert.equal(token.get(), first, 'cached');
    assert.equal(token.get({ force: true }), first, 'no forced refresh within 20 minutes');
    now += 15 * 60_000;
    const forced = token.get({ force: true });
    assert.notEqual(forced, first, 'forced refresh once at least 20 minutes old');
    assert.equal(verifyJwt(`bearer ${forced}`, publicKey).claims.iat, now / 1000);
    now += 49 * 60_000;
    assert.equal(token.get(), forced, 'cached for 50 minutes');
    now += 60_000;
    const refreshed = token.get();
    assert.notEqual(refreshed, forced);
    assert.equal(verifyJwt(`bearer ${refreshed}`, publicKey).claims.iat, now / 1000);
  });

  it('refuses keys that are not EC P-256', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const client = new ApnsClient({ teamId: 'TEAM123456', keyId: 'KEY1234567', keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), bundleId: 'a.b', environments: ['sandbox'], log });
    assert.equal(client.configured, false);
    assert.match(client.error, /EC P-256/);
  });
});

describe('APNs HTTP/2 transport', () => {
  let server;
  let origin;
  let sessions = 0;
  let mode = 'ok';

  before(async () => {
    server = http2.createServer();
    server.on('session', () => {
      sessions += 1;
    });
    server.on('stream', (stream, headers) => {
      if (mode === 'hang') return;
      if (mode === 'goaway-after') {
        stream.respond({ ':status': 200, 'apns-id': 'id-1' });
        stream.end();
        stream.session.goaway();
        return;
      }
      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        body += chunk;
      });
      stream.on('end', () => {
        if (headers[':path'].startsWith('/1/apps/')) {
          stream.respond({ ':status': 201, 'apns-channel-id': 'dHN0LWNoYW5uZWw=' });
          stream.end();
          return;
        }
        if (headers['apns-priority'] === 'bad') {
          stream.respond({ ':status': 400, 'content-type': 'application/json' });
          stream.end(JSON.stringify({ reason: 'BadPriority' }));
          return;
        }
        stream.respond({ ':status': 200, 'apns-id': 'id-1', 'x-echo-length': String(body.length), 'x-auth': headers.authorization ? 'yes' : 'no' });
        stream.end();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('reuses one session, reconnects after GOAWAY and times out hung requests', async () => {
    const transport = new Http2Transport({ log, requestTimeoutMs: 300 });
    try {
      mode = 'ok';
      const startSessions = sessions;
      const results = await Promise.all(
        Array.from({ length: 5 }, () => transport.request({ origin, method: 'POST', path: '/3/device/abc', headers: { authorization: 'bearer x' }, body: '{"aps":{}}' })),
      );
      assert.ok(results.every((r) => r.status === 200 && r.headers['x-echo-length'] === '10' && r.headers['x-auth'] === 'yes'));
      assert.equal(sessions - startSessions, 1, 'one session for many requests');

      mode = 'goaway-after';
      assert.equal((await transport.request({ origin, method: 'GET', path: '/x' })).status, 200);
      mode = 'ok';
      await new Promise((resolve) => setTimeout(resolve, 50));
      const afterGoaway = await transport.request({ origin, method: 'GET', path: '/y' });
      assert.equal(afterGoaway.status, 200);
      assert.equal(sessions - startSessions, 2, 'reconnected after GOAWAY');

      mode = 'hang';
      await assert.rejects(transport.request({ origin, method: 'GET', path: '/slow' }), { code: 'ETIMEDOUT' });
      mode = 'ok';
      assert.equal((await transport.request({ origin, method: 'GET', path: '/z' })).status, 200);
    } finally {
      transport.close();
    }
  });

  it('drives ApnsClient end to end over HTTP/2 and parses error reasons', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const client = new ApnsClient({
      teamId: 'TEAM123456',
      keyId: 'KEY1234567',
      keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      bundleId: 'org.example.app',
      environments: ['sandbox'],
      log,
      origins: { sandbox: { push: origin, manage: origin } },
    });
    try {
      mode = 'ok';
      const created = await client.createChannel('sandbox', 0);
      assert.deepEqual([created.ok, created.status, created.channelId], [true, 201, 'dHN0LWNoYW5uZWw=']);
      const pushed = await client.broadcast('sandbox', created.channelId, { aps: { event: 'update', timestamp: 1, 'content-state': {} } });
      assert.deepEqual([pushed.ok, pushed.apnsId], [true, 'id-1']);
      const rejected = await client.broadcast('sandbox', created.channelId, { aps: {} }, { priority: 'bad' });
      assert.deepEqual([rejected.ok, rejected.status, rejected.reason], [false, 400, 'BadPriority']);
      const tooBig = await client.broadcast('sandbox', created.channelId, { aps: { blob: 'x'.repeat(6000) } });
      assert.deepEqual([tooBig.ok, tooBig.reason], [false, 'PayloadTooLarge']);
      const unreachable = new ApnsClient({
        teamId: 'TEAM123456',
        keyId: 'KEY1234567',
        keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        bundleId: 'org.example.app',
        environments: ['sandbox'],
        log,
        origins: { sandbox: { push: 'http://127.0.0.1:1', manage: 'http://127.0.0.1:1' } },
      });
      const failed = await unreachable.createChannel('sandbox', 0);
      assert.equal(failed.ok, false);
      assert.equal(failed.status, 0);
      assert.equal(failed.network, true);
      assert.equal(failed.reason, 'ECONNREFUSED', 'the underlying connect error, not ERR_HTTP2_STREAM_CANCEL');
      unreachable.close();
    } finally {
      client.close();
    }
  });

  // The CLI's apns-check runs with nothing else keeping the event loop alive;
  // a reconnect backoff must not let the process exit (status 0) mid-check.
  it('finishes a check against an unreachable host in a bare process', async () => {
    const script = `
      import { generateKeyPairSync } from 'node:crypto';
      import { ApnsClient } from ${JSON.stringify(new URL('../server/apns.js', import.meta.url).href)};
      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const apns = new ApnsClient({
        teamId: 'TEAM123456', keyId: 'KEY1234567', bundleId: 'org.example.app', environments: ['sandbox'],
        keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        origins: { sandbox: { push: 'http://127.0.0.1:1', manage: 'http://127.0.0.1:1' } },
      });
      const results = await apns.check(0);
      apns.close();
      process.stdout.write(JSON.stringify(results));
      process.exitCode = results.sandbox.ok ? 0 : 7;
    `;
    const outcome = await new Promise((resolve) => {
      execFile(process.execPath, ['--input-type=module', '-e', script], { timeout: 20_000 }, (err, stdout, stderr) => {
        resolve({ code: err?.code ?? 0, stdout, stderr });
      });
    });
    assert.equal(outcome.code, 7, `exit code (stderr: ${outcome.stderr})`);
    const results = JSON.parse(outcome.stdout);
    assert.equal(results.sandbox.ok, false);
    assert.match(results.sandbox.error, /ECONNREFUSED/);
  });
});

describe('APNs HTTP/2 transport and GOAWAY', () => {
  // The server holds the first three requests on its first session, then
  // sends GOAWAY naming the first of them as the last stream it processed.
  async function goawayServer(errorCode) {
    const server = http2.createServer();
    const seen = { sessions: 0, streams: 0 };
    let held = [];
    server.on('session', (session) => {
      seen.sessions += 1;
      session.number = seen.sessions;
    });
    server.on('stream', (stream, headers) => {
      seen.streams += 1;
      stream.on('error', () => {});
      if (stream.session.number === 1 && headers[':path'] !== '/warm') {
        held.push(stream);
        if (held.length === 3) {
          const [first] = held;
          held = [];
          setTimeout(() => {
            if (errorCode === http2.constants.NGHTTP2_NO_ERROR) {
              first.respond({ ':status': 200 });
              first.end();
            }
            first.session.goaway(errorCode, first.id);
          }, 20);
        }
        return;
      }
      stream.respond({ ':status': 200 });
      stream.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, seen, origin: `http://127.0.0.1:${server.address().port}` };
  }

  it('retries streams a GOAWAY refused, never ones APNs may have processed', async () => {
    for (const errorCode of [http2.constants.NGHTTP2_NO_ERROR, http2.constants.NGHTTP2_INTERNAL_ERROR]) {
      const { server, seen, origin } = await goawayServer(errorCode);
      const transport = new Http2Transport({ log, requestTimeoutMs: 2000 });
      try {
        await transport.request({ origin, method: 'GET', path: '/warm' });
        const results = await Promise.allSettled(
          [1, 2, 3].map((i) => transport.request({ origin, method: 'POST', path: `/3/device/${i}`, body: '{}' })),
        );
        const ok = results.filter((r) => r.status === 'fulfilled' && r.value.status === 200).length;
        if (errorCode === http2.constants.NGHTTP2_NO_ERROR) {
          assert.equal(ok, 3, 'the processed stream answered, the refused two retried');
        } else {
          assert.equal(ok, 2, 'the two streams above lastStreamId retried');
          const failed = results.find((r) => r.status === 'rejected');
          assert.equal(failed.reason.code, 'ERR_HTTP2_SESSION_ERROR', 'the stream APNs may have processed is not resent');
        }
        assert.equal(seen.streams, 1 + 3 + 2);
        assert.equal(seen.sessions, 2);
      } finally {
        transport.close();
        await new Promise((resolve) => server.close(resolve));
      }
    }
  });
});
