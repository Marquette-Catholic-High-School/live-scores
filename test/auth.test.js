import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { hashPassword, verifyPassword } from '../server/auth.js';
import { PASSWORD, startTestApp } from './helpers.js';

describe('auth', () => {
  let t;
  before(async () => {
    t = await startTestApp();
    await t.createUser('admin', 'admin', 'The Admin');
    await t.createUser('keeper', 'scorekeeper', 'Coach Smith');
  });
  after(() => t.close());

  it('hashes passwords with scrypt in the documented format', async () => {
    const hash = await hashPassword('s3cret-password');
    assert.match(hash, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.equal(Buffer.from(hash.split('$')[4], 'base64').length, 16);
    assert.equal(Buffer.from(hash.split('$')[5], 'base64').length, 64);
    assert.equal(await verifyPassword('s3cret-password', hash), true);
    assert.equal(await verifyPassword('wrong-password', hash), false);
    assert.equal(await verifyPassword('x', 'garbage'), false);
  });

  it('web login sets the session cookie and returns only the user', async () => {
    const client = t.client();
    const res = await client.loginWeb('admin');
    assert.deepEqual(Object.keys(res.json).sort(), ['serverTime', 'user']);
    assert.deepEqual(res.json.user, { id: res.json.user.id, username: 'admin', displayName: 'The Admin', role: 'admin' });
    const cookie = res.setCookie.find((c) => c.startsWith('mchs_session='));
    assert.match(cookie, /^mchs_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
    assert.doesNotMatch(cookie, /Secure/, 'no Secure flag over plain http');
    const me = await client.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.user.username, 'admin');
  });

  it('marks the cookie Secure when the proxy says https', async () => {
    const res = await t.client().post('/api/auth/login', { username: 'admin', password: PASSWORD, client: 'web' }, { headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(res.status, 200);
    assert.match(res.setCookie[0], /; HttpOnly; Secure; SameSite=Lax;/);
  });

  it('ios login returns a bearer token', async () => {
    const client = t.client();
    const res = await client.loginIos('KEEPER');
    assert.equal(typeof res.json.token, 'string');
    assert.equal(res.json.user.username, 'keeper');
    assert.equal(res.setCookie.length, 0);
    const me = await client.get('/api/auth/me');
    assert.equal(me.json.user.displayName, 'Coach Smith');
  });

  it('rejects bad credentials and requests without a session', async () => {
    const bad = await t.client().post('/api/auth/login', { username: 'admin', password: 'nope-nope-nope', client: 'web' });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error.code, 'unauthorized');
    assert.equal(typeof bad.json.serverTime, 'number');
    assert.equal((await t.client().post('/api/auth/login', { username: 'admin', password: PASSWORD })).status, 400);
    assert.equal((await t.client().get('/api/auth/me')).status, 401);
    const forged = t.client();
    forged.token = 'A'.repeat(43);
    assert.equal((await forged.get('/api/auth/me')).status, 401);
  });

  it('requires X-MCHS-Client on cookie-authenticated writes only', async () => {
    const web = t.client();
    await web.loginWeb('admin');
    const withoutHeader = await web.post('/api/auth/password', { currentPassword: PASSWORD, newPassword: PASSWORD }, { csrf: false });
    assert.equal(withoutHeader.status, 403);
    assert.equal(withoutHeader.json.error.code, 'forbidden');
    const created = await web.post('/api/games', { sport: 'soccer', away: { name: 'X', code: 'XX', color: '#000000' }, scheduledAt: Date.now() }, { csrf: false });
    assert.equal(created.status, 403);
    const withHeader = await web.post('/api/games', { sport: 'soccer', away: { name: 'X', code: 'XX', color: '#000000' }, scheduledAt: Date.now() });
    assert.equal(withHeader.status, 200);

    const ios = t.client();
    await ios.loginIos('admin');
    const bearer = await ios.post('/api/games', { sport: 'soccer', away: { name: 'Y', code: 'YY', color: '#000000' }, scheduledAt: Date.now() });
    assert.equal(bearer.status, 200, 'bearer requests need no CSRF header');
  });

  it('logout deletes the session and clears the cookie', async () => {
    const web = t.client();
    await web.loginWeb('keeper');
    const cookie = web.cookie;
    const res = await web.post('/api/auth/logout', {});
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.ok, true);
    assert.match(res.setCookie[0], /^mchs_session=; .*Max-Age=0/);
    const stale = t.client();
    stale.cookie = cookie;
    const me = await stale.get('/api/auth/me');
    assert.equal(me.status, 401);

    const ios = t.client();
    await ios.loginIos('keeper');
    assert.equal((await ios.post('/api/auth/logout', {})).status, 200);
    assert.equal((await ios.get('/api/auth/me')).status, 401);
  });

  it('password change validates and revokes the other sessions', async () => {
    await t.createUser('changer', 'scorekeeper');
    const web = t.client();
    await web.loginWeb('changer');
    const ios = t.client();
    await ios.loginIos('changer');

    assert.equal((await web.post('/api/auth/password', { currentPassword: 'wrong-password', newPassword: 'new-password-1' })).status, 403);
    assert.equal((await web.post('/api/auth/password', { currentPassword: PASSWORD, newPassword: 'short' })).status, 400);
    const ok = await web.post('/api/auth/password', { currentPassword: PASSWORD, newPassword: 'new-password-1' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.ok, true);

    assert.equal((await web.get('/api/auth/me')).status, 200, 'current session survives');
    assert.equal((await ios.get('/api/auth/me')).status, 401, 'other sessions are revoked');
    assert.equal((await t.client().post('/api/auth/login', { username: 'changer', password: PASSWORD, client: 'ios' })).status, 401);
    assert.equal((await t.client().post('/api/auth/login', { username: 'changer', password: 'new-password-1', client: 'ios' })).status, 200);
  });

  it('refuses disabled accounts', async () => {
    const user = await t.createUser('disabled-user', 'scorekeeper');
    await t.app.users.update(user.id, { disabled: true });
    const res = await t.client().post('/api/auth/login', { username: 'disabled-user', password: PASSWORD, client: 'web' });
    assert.equal(res.status, 403);
  });

  it('slides sessions forward and expires them after 30 idle days', async () => {
    const web = t.client();
    await web.loginWeb('admin');
    const first = await web.get('/api/auth/me');
    assert.equal(first.setCookie.length, 0, 'not refreshed within the hour');
    t.clock.advance(2 * 60 * 60 * 1000);
    const refreshed = await web.get('/api/auth/me');
    assert.equal(refreshed.status, 200);
    assert.match(refreshed.setCookie[0] ?? '', /^mchs_session=.+Max-Age=2592000/);
    t.clock.advance(31 * 24 * 60 * 60 * 1000);
    const expired = await web.get('/api/auth/me');
    assert.equal(expired.status, 401);
    assert.match(expired.setCookie[0] ?? '', /Max-Age=0/);
  });

  it('rate-limits failed logins per username and per IP', async () => {
    await t.createUser('victim', 'scorekeeper');
    const login = (ip, username, password) => t.client({ forwardedFor: ip }).post('/api/auth/login', { username, password, client: 'web' });
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await login(`203.0.113.${i + 1}`, 'victim', 'wrong-password')).status, 401);
    }
    // The username is locked for the sources that failed on it…
    const blocked = await login('203.0.113.1', 'victim', PASSWORD);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.error.code, 'rate_limited');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    // …but someone guessing elsewhere can't lock the real user out.
    assert.equal((await login('203.0.113.99', 'victim', PASSWORD)).status, 200);
    // A fresh source gets one try while the username is locked.
    assert.equal((await login('203.0.113.100', 'victim', 'wrong-again')).status, 401);
    assert.equal((await login('203.0.113.100', 'victim', PASSWORD)).status, 429);

    // Per address the limit is higher (a school shares one public IP).
    const attacker = t.client({ forwardedFor: '198.51.100.7' });
    for (let i = 0; i < 50; i += 1) {
      assert.equal((await attacker.post('/api/auth/login', { username: `nobody${i}`, password: 'wrong-password', client: 'web' })).status, 401);
    }
    assert.equal((await attacker.post('/api/auth/login', { username: 'admin', password: PASSWORD, client: 'web' })).status, 429);
    assert.equal((await t.client({ forwardedFor: '198.51.100.8' }).post('/api/auth/login', { username: 'admin', password: PASSWORD, client: 'web' })).status, 200);

    t.clock.advance(16 * 60 * 1000);
    assert.equal((await attacker.post('/api/auth/login', { username: 'admin', password: PASSWORD, client: 'web' })).status, 200);
  });

  it('counts concurrent guesses before checking them', async () => {
    await t.createUser('burst', 'scorekeeper');
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => t.client({ forwardedFor: '192.0.2.200' }).post('/api/auth/login', { username: 'burst', password: `guess-${i}-xxxx`, client: 'ios' })),
    );
    const statuses = results.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 401).length, 10, 'only 10 guesses are ever checked');
    assert.equal(statuses.filter((s) => s === 429).length, 40);
    assert.equal((await t.client({ forwardedFor: '192.0.2.200' }).post('/api/auth/login', { username: 'burst', password: PASSWORD, client: 'ios' })).status, 429);
  });

  it('counts an IPv6 client per /64', async () => {
    for (let i = 0; i < 50; i += 1) {
      const res = await t.client({ forwardedFor: `2001:db8:1234:5678::${(i + 1).toString(16)}` }).post('/api/auth/login', { username: `v6nobody${i}`, password: 'wrong-password', client: 'web' });
      assert.equal(res.status, 401);
    }
    const sameNet = await t.client({ forwardedFor: '2001:db8:1234:5678:ffff:1:2:3' }).post('/api/auth/login', { username: 'admin', password: PASSWORD, client: 'web' });
    assert.equal(sameNet.status, 429);
    const otherNet = await t.client({ forwardedFor: '2001:db8:1234:5679::1' }).post('/api/auth/login', { username: 'admin', password: PASSWORD, client: 'web' });
    assert.equal(otherNet.status, 200);
  });

  it('throttles wrong current passwords on password change', async () => {
    await t.createUser('stolen', 'scorekeeper');
    const ios = t.client();
    await ios.loginIos('stolen');
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await ios.post('/api/auth/password', { currentPassword: `guess-${i}-xx`, newPassword: 'taken-over-1' })).status, 403);
    }
    const limited = await ios.post('/api/auth/password', { currentPassword: PASSWORD, newPassword: 'taken-over-1' });
    assert.equal(limited.status, 429);
    assert.equal((await t.client().post('/api/auth/login', { username: 'stolen', password: PASSWORD, client: 'ios' })).status, 200, 'password unchanged');
    t.clock.advance(16 * 60 * 1000);
    assert.equal((await ios.post('/api/auth/password', { currentPassword: PASSWORD, newPassword: 'new-password-2' })).status, 200);
  });
});
