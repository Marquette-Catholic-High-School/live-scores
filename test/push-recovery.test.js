// Push work that must survive APNs failures, game deletion and restarts:
// channel creation at start, the push-to-start fan-out, timestamps, the end
// broadcast and channel cleanup (ARCHITECTURE.md §8).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { act, createGame, hexToken, sleep, startGame, startTestApp, waitFor } from './helpers.js';

const HOUR = 60 * 60 * 1000;
const PROD = { APNS_ENVIRONMENTS: 'production' };

function pushLog(t, gameId, kind) {
  return t.app.db.all('SELECT * FROM push_log WHERE game_id = ? AND kind = ? ORDER BY id', gameId, kind);
}

async function register(t, seed, environment = 'production') {
  const res = await t.client().post('/api/devices', { token: hexToken(seed), environment, enabled: true, activitiesEnabled: true, appVersion: '5.1' });
  assert.equal(res.status, 200);
  return hexToken(seed);
}

// Inserts `count` enabled production devices directly; returns their tokens.
function seedDevices(t, prefix, count) {
  const tokens = [];
  t.app.db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      const token = Buffer.from(`${prefix}-${i}`.padEnd(32, 'x')).toString('hex');
      t.app.db.run("INSERT INTO devices (token, environment, created_at, updated_at) VALUES (?, 'production', 1, 1)", token);
      tokens.push(token);
    }
  });
  return tokens;
}

const tokenOf = (call) => call.path.slice('/3/device/'.length);
const ends = (t, gameId) => t.transport.byKind('broadcast').filter((c) => c.json.aps.event === 'end' && (!gameId || c.json.aps['content-state']));

describe('push recovery', () => {
  it('retries channel creation at start, so one APNs error does not cost an environment its Live Activities', async () => {
    const t = await startTestApp({ env: PROD });
    try {
      const admin = await t.signedIn('admin', 'admin');
      const tokens = [await register(t, 'retry-a'), await register(t, 'retry-b'), await register(t, 'retry-c')];
      let failed = false;
      t.transport.respond((call) => {
        if (call.kind !== 'channel-create' || failed) return undefined;
        failed = true;
        return { status: 503, body: '{"reason":"ServiceUnavailable"}' };
      });
      const game = await createGame(admin, { scheduledAt: Date.now() });
      await startGame(admin, game.id);
      await waitFor(() => pushLog(t, game.id, 'start').length === 1, { message: 'start flow' });
      assert.deepEqual(t.transport.byKind('device').map(tokenOf).sort(), [...tokens].sort());
      assert.equal(pushLog(t, game.id, 'start')[0].sent, 3);
      assert.equal(t.transport.byKind('channel-create').length, 2);
    } finally {
      await t.close();
    }
  });

  it('sends the push-to-start once a channel exists when creation kept failing at start', async () => {
    const t = await startTestApp({ env: PROD });
    try {
      const admin = await t.signedIn('admin', 'admin');
      const tokens = [await register(t, 'late-a'), await register(t, 'late-b')];
      let apnsDown = true;
      t.transport.respond((call) => (call.kind === 'channel-create' && apnsDown ? { status: 503, body: '{"reason":"ServiceUnavailable"}' } : undefined));

      // Recovered by the next scoring update…
      const game = await createGame(admin, { scheduledAt: Date.now() });
      await startGame(admin, game.id);
      await waitFor(() => pushLog(t, game.id, 'start').length === 1, { message: 'start skipped' });
      assert.match(pushLog(t, game.id, 'start')[0].detail, /skipped: no broadcast channel/);
      apnsDown = false;
      await act(admin, game.id, { type: 'score', team: 'home', points: 2 });
      await waitFor(() => t.transport.byKind('device').length === 2, { message: 'push-to-start after the update created the channel' });
      const channel = t.app.games.getGame(game.id).channels.production;
      assert.ok(t.transport.byKind('device').every((c) => c.json.aps['input-push-channel'] === channel && c.json.aps['content-state'].homeScore === 2));

      // …or by the scheduler when nothing else happens.
      apnsDown = true;
      const quiet = await createGame(admin, { scheduledAt: Date.now() });
      await startGame(admin, quiet.id);
      await waitFor(() => pushLog(t, quiet.id, 'start').length === 1);
      const mark = t.transport.calls.length;
      apnsDown = false;
      await t.app.scheduler.tick();
      await waitFor(() => t.transport.calls.slice(mark).filter((c) => c.kind === 'device').length === 2, { message: 'resumed by the scheduler' });
      assert.deepEqual(t.transport.calls.slice(mark).filter((c) => c.kind === 'device').map(tokenOf).sort(), [...tokens].sort());

      // Nobody gets a second one.
      await t.app.scheduler.tick();
      await act(admin, quiet.id, { type: 'score', team: 'away', points: 1 });
      await sleep(50);
      assert.equal(t.transport.byKind('device').length, 4);
    } finally {
      await t.close();
    }
  });

  it('resumes an interrupted fan-out after a restart without sending anyone a second one', async () => {
    const first = await startTestApp({ env: PROD });
    let second = null;
    try {
      const admin = await first.signedIn('admin', 'admin');
      const tokens = seedDevices(first, 'fan', 250);
      // Uneven latency, so a block of devices is only partly handed out when
      // the server stops.
      let n = 0;
      first.transport.respond(async (call) => {
        n += 1;
        if (call.kind === 'device') await sleep(5 + (n % 7) * 9);
        return undefined;
      });
      const game = await createGame(admin, { scheduledAt: Date.now() });
      await startGame(admin, game.id);
      await waitFor(() => first.transport.byKind('device').length >= 120, { message: 'fan-out under way' });
      await first.close({ keepData: true, pushFlushTimeoutMs: 0 });
      await sleep(60);
      const sentBefore = first.transport.byKind('device').map(tokenOf);
      assert.ok(sentBefore.length < 250, 'interrupted');

      second = await startTestApp({ dir: first.dir, clock: first.clock, env: PROD });
      const lateFan = await register(second, 'registered-after-the-start');
      await second.app.scheduler.tick();
      await waitFor(() => pushLog(second, game.id, 'start').length === 1, { message: 'resumed fan-out' });
      const sentAfter = second.transport.byKind('device').map(tokenOf);
      assert.equal(sentBefore.length + sentAfter.length, 250);
      assert.deepEqual(new Set([...sentBefore, ...sentAfter]), new Set(tokens), 'every device got one');
      assert.ok(sentAfter.every((token) => !sentBefore.includes(token)), 'nobody got two');
      assert.ok(!sentAfter.includes(lateFan), 'the fan-out covers the devices registered at the start');
      assert.equal(second.app.db.get('SELECT start_pending FROM push_progress WHERE game_id = ?', game.id).start_pending, 0);
    } finally {
      if (second) await second.close();
      else await first.close();
    }
  });

  it('keeps APNs timestamps increasing across a restart and re-sends the live state', async () => {
    const first = await startTestApp({ env: PROD });
    let second = null;
    try {
      const admin = await first.signedIn('admin', 'admin');
      const game = await createGame(admin, { scheduledAt: Date.now() });
      await startGame(admin, game.id);
      await waitFor(() => first.app.games.getGame(game.id).channels.production);
      for (let i = 0; i < 5; i += 1) await act(admin, game.id, { type: 'score', team: 'home', points: 1 });
      await waitFor(() => first.transport.byKind('broadcast').length === 5);
      const last = Math.max(...first.transport.calls.filter((c) => c.json?.aps).map((c) => c.json.aps.timestamp));
      await first.close({ keepData: true });

      first.clock.advance(-HOUR); // the server clock stepped back
      second = await startTestApp({ dir: first.dir, clock: first.clock, env: PROD });
      await second.app.scheduler.tick();
      const resync = await waitFor(() => second.transport.byKind('broadcast')[0], { message: 'state re-sent after the restart' });
      assert.ok(resync.json.aps.timestamp > last, `${resync.json.aps.timestamp} > ${last}`);
      assert.equal(resync.json.aps.event, 'update');
      assert.equal(resync.json.aps['content-state'].homeScore, 5);
      assert.equal(resync.headers['apns-priority'], '10');
      await second.app.scheduler.tick();
      assert.equal(second.transport.byKind('broadcast').length, 1, 'once per restart');

      const keeper = second.client();
      keeper.cookie = admin.cookie;
      await keeper.post(`/api/games/${game.id}/end`, {});
      const end = await waitFor(() => second.transport.byKind('broadcast').find((c) => c.json.aps.event === 'end'));
      assert.ok(end.json.aps.timestamp > resync.json.aps.timestamp);
    } finally {
      if (second) await second.close();
      else await first.close();
    }
  });

  it('sends the latest state on a graceful shutdown even if it changed during a send', async () => {
    const t = await startTestApp({ env: { ...PROD, APNS_MIN_UPDATE_INTERVAL_MS: '5000' } });
    const admin = await t.signedIn('admin', 'admin');
    const game = await createGame(admin, { scheduledAt: Date.now() });
    await startGame(admin, game.id);
    await waitFor(() => t.app.games.getGame(game.id).channels.production);
    t.transport.respond(async (call) => {
      if (call.kind === 'broadcast') await sleep(300);
      return undefined;
    });
    await act(admin, game.id, { type: 'score', team: 'home', points: 2 });
    await waitFor(() => t.transport.byKind('broadcast').length === 1);
    await act(admin, game.id, { type: 'score', team: 'home', points: 3 });
    await t.close({ pushFlushTimeoutMs: 3000 });
    assert.deepEqual(t.transport.byKind('broadcast').map((c) => c.json.aps['content-state'].homeScore), [2, 5]);
  });

  it('keeps retrying the end until it is delivered, across a restart, and deletes the channel only after it', async () => {
    const first = await startTestApp({ env: { ...PROD, APNS_MIN_UPDATE_INTERVAL_MS: '100' } });
    let second = null;
    try {
      const admin = await first.signedIn('admin', 'admin');
      const game = await createGame(admin, { scheduledAt: Date.now() });
      await startGame(admin, game.id);
      await waitFor(() => first.app.games.getGame(game.id).channels.production);
      const channel = first.app.games.getGame(game.id).channels.production;
      first.transport.respond((call) => (call.kind === 'broadcast' ? { status: 429, body: '{"reason":"TooManyRequests"}' } : undefined));
      await act(admin, game.id, { type: 'note', text: 'Timeout' });
      await waitFor(() => first.app.push.updateIntervalMs(game.id) >= 200, { message: 'throttled' });
      const interval = first.app.push.updateIntervalMs(game.id);
      const mark = first.transport.calls.length;
      await admin.post(`/api/games/${game.id}/end`, {});
      await waitFor(() => pushLog(first, game.id, 'end').length === 1, { timeout: 5000, message: 'handed to the scheduler' });
      assert.match(pushLog(first, game.id, 'end')[0].detail, /429 TooManyRequests \(retrying every minute\)/);
      const attempts = first.transport.calls.slice(mark).filter((c) => c.json?.aps?.event === 'end');
      assert.equal(attempts.length, 3);
      for (let i = 1; i < attempts.length; i += 1) assert.ok(attempts[i].at - attempts[i - 1].at >= interval - 5, 'waits out the throttled interval');
      assert.equal(attempts[0].json.aps['content-state'].note, '', 'the final state has no note');
      await first.close({ keepData: true });

      second = await startTestApp({ dir: first.dir, clock: first.clock, env: PROD });
      second.clock.advance(7 * HOUR);
      second.transport.respond((call) => (call.json?.aps?.event === 'end' ? { status: 503, body: '{"reason":"ServiceUnavailable"}' } : undefined));
      await second.app.scheduler.tick();
      assert.equal(second.transport.calls.filter((c) => c.json?.aps?.event === 'end').length, 1, 'retried after the restart');
      assert.equal(second.transport.byKind('channel-delete').length, 0, 'the channel outlives an undelivered end');

      second.transport.clearHandlers();
      second.clock.advance(2 * 60_000);
      await second.app.scheduler.tick();
      const end = second.transport.calls.filter((c) => c.json?.aps?.event === 'end').at(-1);
      assert.deepEqual(end.json, attempts[0].json, 'the same end, timestamp included');
      const deletion = second.transport.byKind('channel-delete')[0];
      assert.equal(deletion.headers['apns-channel-id'], channel);
      assert.ok(second.transport.calls.indexOf(deletion) > second.transport.calls.indexOf(end));
      assert.equal(pushLog(second, game.id, 'end').at(-1).sent, 1);
      assert.equal(second.app.db.get('SELECT COUNT(*) AS n FROM pending_ends').n, 0);
      assert.equal(second.app.games.getGame(game.id).channels.production, null);
    } finally {
      if (second) await second.close();
      else await first.close();
    }
  });

  it('deletes the channels of a canceled game only after its end broadcast went out, and never leaks them', async () => {
    const t = await startTestApp({ env: PROD });
    try {
      const admin = await t.signedIn('admin', 'admin');
      const game = await createGame(admin, { scheduledAt: Date.now() });
      await startGame(admin, game.id);
      await waitFor(() => t.app.games.getGame(game.id).channels.production);
      const channel = t.app.games.getGame(game.id).channels.production;
      t.transport.respond((call) => (call.json?.aps?.event === 'end' ? { status: 503, body: '{"reason":"ServiceUnavailable"}' } : undefined));
      assert.equal((await admin.delete(`/api/games/${game.id}`)).status, 409, 'live games are canceled first');
      assert.equal((await admin.post(`/api/games/${game.id}/cancel`, {})).status, 200);
      assert.equal((await admin.delete(`/api/games/${game.id}`)).status, 200);
      assert.equal((await admin.get(`/api/games/${game.id}`)).status, 404);
      await waitFor(() => pushLog(t, game.id, 'end').length === 1, { message: 'end attempted' });
      const end = t.transport.calls.find((c) => c.json?.aps?.event === 'end');
      assert.deepEqual([end.json.aps['content-state'].status, end.json.aps['content-state'].note], ['canceled', 'Canceled']);
      assert.equal(end.headers['apns-channel-id'], channel);

      t.clock.advance(7 * HOUR);
      await t.app.scheduler.tick();
      assert.equal(t.transport.byKind('channel-delete').length, 0, 'not before the end is delivered');

      t.transport.clearHandlers();
      t.transport.respond((call) => (call.kind === 'channel-delete' ? { status: 500, body: '{"reason":"InternalServerError"}' } : undefined));
      t.clock.advance(2 * 60_000);
      await t.app.scheduler.tick();
      assert.equal(pushLog(t, game.id, 'end').at(-1).sent, 1, 'end delivered');
      assert.equal(t.transport.byKind('channel-delete').length, 1, 'then the channel delete is tried');
      assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM channel_cleanup').n, 1, 'and kept for a retry when it fails');

      t.transport.clearHandlers();
      t.clock.advance(11 * 60_000);
      await t.app.scheduler.tick();
      assert.equal(t.transport.byKind('channel-delete').length, 2);
      assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM channel_cleanup').n, 0);
      assert.match(pushLog(t, game.id, 'channel').at(-1).detail, /^deleted /);
    } finally {
      await t.close();
    }
  });

  it('stops a push-to-start fan-out when the game ends and sends the end after it', async () => {
    const t = await startTestApp({ env: PROD });
    try {
      const admin = await t.signedIn('admin', 'admin');
      seedDevices(t, 'canceled-fan', 400);
      t.transport.respond(async (call) => {
        if (call.kind === 'device') await sleep(40);
        return undefined;
      });
      const game = await createGame(admin, { scheduledAt: Date.now() });
      await startGame(admin, game.id);
      await waitFor(() => t.transport.byKind('device').length >= 50, { message: 'fan-out under way' });
      await admin.post(`/api/games/${game.id}/cancel`, {});
      const end = await waitFor(() => t.transport.byKind('broadcast').find((c) => c.json.aps.event === 'end'), { message: 'end broadcast' });
      await sleep(100);
      const starts = t.transport.byKind('device');
      assert.ok(starts.length < 400, `stopped after ${starts.length}`);
      assert.ok(starts.every((c) => c.at <= end.at), 'no push-to-start after the end');
      assert.equal(end.json.aps['content-state'].status, 'canceled');
      assert.match(pushLog(t, game.id, 'start')[0].detail, /stopped \(game canceled\)/);
    } finally {
      await t.close();
    }
  });
});
