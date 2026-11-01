import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { act, createGame, openStream, sleep, startGame, startTestApp, waitFor } from './helpers.js';

describe('SSE /api/stream', () => {
  let t;
  let admin;
  const streams = [];
  const open = async (...args) => {
    const stream = await openStream(t.baseUrl, ...args);
    streams.push(stream);
    return stream;
  };

  before(async () => {
    t = await startTestApp({ appOptions: { sseOptions: { maxPerIp: 4, pingIntervalMs: 100 } } });
    admin = await t.signedIn('admin', 'admin');
  });
  after(async () => {
    for (const stream of streams) stream.close?.();
    await t.close();
  });

  it('sends retry, hello, game events and pings', async () => {
    const stream = await open();
    assert.equal(stream.res.status, 200);
    assert.equal(stream.res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(stream.res.headers.get('cache-control'), 'no-cache, no-transform');
    assert.equal(stream.res.headers.get('x-accel-buffering'), 'no');
    const hello = await stream.next((e) => e.event === 'hello');
    assert.deepEqual(Object.keys(hello.data), ['serverTime']);
    assert.ok(stream.raw.startsWith('retry: 3000\n\nevent: hello\ndata: {"serverTime":'));

    const game = await createGame(admin);
    const created = await stream.next((e) => e.event === 'game' && e.data.game.id === game.id);
    assert.equal(created.dataLines, 1, 'data is one line of JSON');
    assert.equal(typeof created.data.serverTime, 'number');
    assert.equal(created.data.game.status, 'scheduled');
    assert.equal('scorekeeper' in created.data.game, false, 'anonymous stream');

    await startGame(admin, game.id);
    await act(admin, game.id, { type: 'score', team: 'home', points: 3 });
    const scored = await stream.next((e) => e.event === 'game' && e.data.game.id === game.id && e.data.game.home.score === 3);
    assert.equal(scored.data.game.status, 'live');
    await sleep(150);
    assert.ok(stream.comments.includes(': ping'));
  });

  it('escapes Unicode line separators so data stays on one line', async () => {
    const game = await createGame(admin);
    await startGame(admin, game.id);
    const stream = await open(`/api/stream?game=${game.id}`);
    await stream.next((e) => e.event === 'hello');
    const text = 'Rain\u2028Delay\u2029Now';
    assert.equal((await act(admin, game.id, { type: 'note', text })).status, 200);
    const event = await stream.next((e) => e.event === 'game' && e.data.game.note !== '');
    assert.equal(event.data.game.note, text, 'the JSON still decodes to the original text');
    assert.equal(/[\u0085\u2028\u2029]/.test(stream.raw), false, 'no raw U+0085/U+2028/U+2029 on the wire');
    assert.ok(stream.raw.includes('Rain\\u2028Delay\\u2029Now'));
  });

  it('filters by ?game and reports removals', async () => {
    const a = await createGame(admin);
    const b = await createGame(admin);
    const stream = await open(`/api/stream?game=${a.id}`);
    await stream.next((e) => e.event === 'hello');
    await admin.patch(`/api/games/${b.id}`, { location: 'B field' });
    await admin.patch(`/api/games/${a.id}`, { location: 'A field' });
    const update = await stream.next((e) => e.event === 'game');
    assert.equal(update.data.game.id, a.id);
    assert.equal(update.data.game.location, 'A field');
    await admin.delete(`/api/games/${b.id}`);
    await admin.delete(`/api/games/${a.id}`);
    const removed = await stream.next((e) => e.event === 'removed');
    assert.deepEqual(Object.keys(removed.data).sort(), ['id', 'serverTime']);
    assert.equal(removed.data.id, a.id);
    assert.ok(stream.events.every((e) => e.event === 'hello' || e.data.game?.id === a.id || e.data.id === a.id));

    const missing = await openStream(t.baseUrl, '/api/stream?game=nosuchgame');
    assert.equal(missing.res.status, 404);
  });

  it('includes the scorekeeper for signed-in viewers', async () => {
    const stream = await open('/api/stream', { cookie: admin.cookie });
    await stream.next((e) => e.event === 'hello');
    const game = await createGame(admin);
    await admin.post(`/api/games/${game.id}/claim`, {});
    const event = await stream.next((e) => e.event === 'game' && e.data.game.id === game.id && e.data.game.scorekeeper);
    assert.equal(event.data.game.scorekeeper.name, 'admin name');
  });

  it('limits concurrent streams per IP', async () => {
    for (const stream of streams.splice(0)) stream.close();
    await sleep(50);
    const opened = [];
    for (let i = 0; i < 4; i += 1) opened.push(await open('/api/stream', { 'x-forwarded-for': '192.0.2.10' }));
    assert.ok(opened.every((s) => s.res.status === 200));
    const refused = await openStream(t.baseUrl, '/api/stream', { 'x-forwarded-for': '192.0.2.10' });
    assert.equal(refused.res.status, 429);
    assert.equal(JSON.parse(refused.body).error.code, 'rate_limited');
    const otherIp = await open('/api/stream', { 'x-forwarded-for': '192.0.2.11' });
    assert.equal(otherIp.res.status, 200);
    assert.equal(t.app.sse.size, 5);
    opened[0].close();
    await sleep(50);
    const again = await open('/api/stream', { 'x-forwarded-for': '192.0.2.10' });
    assert.equal(again.res.status, 200);
  });

  it('counts IPv6 streams per /64', async () => {
    for (const stream of streams.splice(0)) stream.close();
    await sleep(50);
    for (let i = 0; i < 4; i += 1) assert.equal((await open('/api/stream', { 'x-forwarded-for': `2001:db8:5::${i + 1}` })).res.status, 200);
    const refused = await openStream(t.baseUrl, '/api/stream', { 'x-forwarded-for': '2001:db8:5:0:abcd::9' });
    assert.equal(refused.res.status, 429);
    assert.equal((await open('/api/stream', { 'x-forwarded-for': '2001:db8:6::1' })).res.status, 200);
  });

  it('stops sending staff-only fields once the session is revoked', async () => {
    for (const stream of streams.splice(0)) stream.close();
    await sleep(50);
    const keeper = await t.signedIn('revoked-keeper');
    const stream = await open('/api/stream', { cookie: keeper.cookie });
    await stream.next((e) => e.event === 'hello');
    const game = await createGame(admin);
    await stream.next((e) => e.event === 'game' && e.data.game.id === game.id && 'scorekeeper' in e.data.game);

    const user = t.app.users.getByUsername('revoked-keeper');
    await t.app.users.update(user.id, { disabled: true });
    await sleep(250);
    await admin.patch(`/api/games/${game.id}`, { location: 'After revoke' });
    const after = await stream.next((e) => e.event === 'game' && e.data.game.location === 'After revoke');
    assert.equal('scorekeeper' in after.data.game, false);
    assert.equal(stream.closed, false, 'the stream stays open for public data');

    const other = await t.signedIn('logout-keeper');
    const second = await open('/api/stream', { cookie: other.cookie });
    await second.next((e) => e.event === 'hello');
    await other.post('/api/auth/logout', {});
    await sleep(250);
    await admin.patch(`/api/games/${game.id}`, { location: 'After logout' });
    const loggedOut = await waitFor(() => second.events.find((e) => e.event === 'game' && e.data.game.location === 'After logout'));
    assert.equal('scorekeeper' in loggedOut.data.game, false);
  });
});
