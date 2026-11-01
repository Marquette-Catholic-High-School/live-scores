import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';
import { openDatabase } from '../server/db.js';
import { act, createGame, startGame, startTestApp, waitFor } from './helpers.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('scheduler', () => {
  let t;
  let admin;
  before(async () => {
    t = await startTestApp();
    admin = await t.signedIn('admin', 'admin');
  });
  after(() => t.close());

  it('auto-finalizes live games after AUTO_FINAL_HOURS and deletes channels 6 h after the end', async () => {
    const stale = await createGame(admin, { scheduledAt: Date.now() });
    await startGame(admin, stale.id);
    await waitFor(() => {
      const game = t.app.games.getGame(stale.id);
      return game.channels.production && game.channels.sandbox;
    });
    await act(admin, stale.id, { type: 'clock', op: 'start' });
    const channels = { ...t.app.games.getGame(stale.id).channels };

    t.clock.advance(3 * HOUR);
    const fresh = await createGame(admin, { scheduledAt: t.clock.now() });
    await startGame(admin, fresh.id);

    let summary = await t.app.scheduler.tick();
    assert.deepEqual(summary.autoFinal, [], 'nothing older than 4 h yet');
    t.clock.advance(HOUR + 60_000);
    const mark = t.transport.calls.length;
    summary = await t.app.scheduler.tick();
    assert.deepEqual(summary.autoFinal, [stale.id]);

    const ended = (await admin.get(`/api/games/${stale.id}`)).json.game;
    assert.equal(ended.status, 'final');
    assert.equal(ended.clock.running, false);
    assert.equal(ended.endedAt, t.app.games.getGame(stale.id).endedAt);
    assert.equal((await admin.get(`/api/games/${fresh.id}`)).json.game.status, 'live', 'younger games stay live');
    await waitFor(() => t.transport.calls.slice(mark).filter((c) => c.json?.aps?.event === 'end').length === 2, { message: 'end push' });

    // Channels survive until 6 h after the end.
    t.clock.advance(5 * HOUR);
    await t.app.scheduler.tick();
    assert.deepEqual(t.app.games.getGame(stale.id).channels, channels);

    t.clock.advance(HOUR + 60_000);
    const deleteMark = t.transport.calls.length;
    await t.app.scheduler.tick();
    const deletes = t.transport.calls.slice(deleteMark).filter((c) => c.kind === 'channel-delete');
    assert.deepEqual(deletes.map((c) => c.headers['apns-channel-id']).sort(), [channels.production, channels.sandbox].sort());
    assert.deepEqual(t.app.games.getGame(stale.id).channels, { production: null, sandbox: null });
    const fresher = t.app.games.getGame(fresh.id);
    assert.equal(fresher.status, 'final', 'the second game was auto-finalized meanwhile');
  });

  it('never auto-finalizes a game that is still being scored', async () => {
    const game = await createGame(admin, { scheduledAt: t.clock.now() });
    await startGame(admin, game.id);
    await waitFor(() => t.app.games.getGame(game.id).channels.production && t.app.games.getGame(game.id).channels.sandbox);
    t.clock.advance(4 * HOUR - 60_000);
    assert.equal((await act(admin, game.id, { type: 'score', team: 'home', points: 6 })).status, 200);
    t.clock.advance(2 * 60_000);
    let summary = await t.app.scheduler.tick();
    assert.ok(!summary.autoFinal.includes(game.id), 'scored a minute ago');
    assert.equal((await act(admin, game.id, { type: 'score', team: 'home', points: 1 })).status, 200);
    t.clock.advance(4 * HOUR + 60_000);
    summary = await t.app.scheduler.tick();
    assert.ok(summary.autoFinal.includes(game.id), 'idle for AUTO_FINAL_HOURS');
    assert.equal(t.app.games.getGame(game.id).status, 'final');
  });

  it('retries a failed channel delete later and treats a vanished channel as deleted', async () => {
    const game = await createGame(admin, { scheduledAt: t.clock.now() });
    await startGame(admin, game.id);
    await waitFor(() => t.app.games.getGame(game.id).channels.sandbox && t.app.games.getGame(game.id).channels.production);
    await admin.post(`/api/games/${game.id}/end`, {});
    t.transport.respond((call) => {
      if (call.kind !== 'channel-delete') return undefined;
      return call.origin.includes('sandbox') ? { status: 500, body: '{"reason":"InternalServerError"}' } : { status: 400, body: '{"reason":"BadChannelId"}' };
    });
    t.clock.advance(7 * HOUR);
    await t.app.scheduler.tick();
    t.transport.clearHandlers();
    const stored = t.app.games.getGame(game.id);
    assert.equal(stored.channels.production, null, 'BadChannelId means it is already gone');
    assert.ok(stored.channels.sandbox, 'server error keeps the id for a retry');
    const failed = t.app.db.get("SELECT * FROM push_log WHERE game_id = ? AND kind = 'channel' AND failed = 1 ORDER BY id DESC", game.id);
    assert.match(failed.detail, /delete failed: 500/);
  });

  it('cleans up old push logs, expired sessions and long-invalid devices', async () => {
    const now = t.clock.now();
    t.app.db.run("INSERT INTO push_log (game_id, kind, environment, sent, failed, detail, created_at) VALUES ('x', 'update', 'production', 1, 0, 'old', ?)", now - 31 * DAY);
    t.app.db.run("INSERT INTO push_log (game_id, kind, environment, sent, failed, detail, created_at) VALUES ('x', 'update', 'production', 1, 0, 'recent', ?)", now - DAY);
    const user = await t.createUser('sessionuser');
    t.app.db.run("INSERT INTO sessions (id, user_id, client, created_at, last_used_at, expires_at) VALUES ('expired-session', ?, 'web', ?, ?, ?)", user.id, now - 40 * DAY, now - 40 * DAY, now - 10 * DAY);
    t.app.db.run("INSERT INTO devices (token, environment, created_at, updated_at, invalid_at, last_error) VALUES (?, 'production', ?, ?, ?, 'Unregistered')", 'ab'.repeat(32), now - 60 * DAY, now - 60 * DAY, now - 31 * DAY);
    t.app.db.run("INSERT INTO devices (token, environment, created_at, updated_at, invalid_at, last_error) VALUES (?, 'production', ?, ?, ?, 'Unregistered')", 'cd'.repeat(32), now - 60 * DAY, now - 60 * DAY, now - 2 * DAY);

    const summary = await t.app.scheduler.tick();
    assert.ok(summary.pushLogDeleted >= 1);
    assert.equal(t.app.db.get("SELECT COUNT(*) AS n FROM push_log WHERE detail = 'old'").n, 0);
    assert.equal(t.app.db.get("SELECT COUNT(*) AS n FROM push_log WHERE detail = 'recent'").n, 1);
    assert.equal(t.app.db.get("SELECT COUNT(*) AS n FROM sessions WHERE id = 'expired-session'").n, 0);
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM devices WHERE token = ?', 'ab'.repeat(32)).n, 0);
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM devices WHERE token = ?', 'cd'.repeat(32)).n, 1);
  });

  it('cleans up the channels of games that ended before the upgrade', async () => {
    const local = await startTestApp();
    const dir = local.dir;
    await local.close({ keepData: true });
    // Back to schema 1 with a game that ended an hour ago, channels still set.
    const db = openDatabase(path.join(dir, 'data', 'live.db'));
    const endedAt = local.clock.now() - HOUR;
    db.exec('DROP TABLE push_progress; DROP TABLE pending_ends; DROP TABLE channel_cleanup; PRAGMA user_version = 1');
    db.run(
      `INSERT INTO games (id, sport, home_name, home_code, home_color, away_name, away_code, away_color, scheduled_at, status,
                          channel_production, channel_sandbox, ended_at, created_at, updated_at)
       VALUES ('legacygame', 'soccer', 'A', 'AA', '#000000', 'B', 'BB', '#000000', ?, 'final', 'cHJvZA==', 'c2FuZA==', ?, ?, ?)`,
      endedAt, endedAt, endedAt, endedAt,
    );
    db.close();
    const upgraded = await startTestApp({ dir, clock: local.clock });
    try {
      assert.equal(upgraded.app.db.schemaVersion, 2);
      await upgraded.app.scheduler.tick();
      assert.equal(upgraded.transport.byKind('channel-delete').length, 0, 'kept until 6 h after the end');
      upgraded.clock.advance(5 * HOUR + 60_000);
      await upgraded.app.scheduler.tick();
      assert.deepEqual(upgraded.transport.byKind('channel-delete').map((c) => c.headers['apns-channel-id']).sort(), ['c2FuZA==', 'cHJvZA==']);
      assert.deepEqual(upgraded.app.games.getGame('legacygame').channels, { production: null, sandbox: null });
    } finally {
      await upgraded.close();
    }
  });

  it('deletes idle devices of an environment the server does not serve', async () => {
    const local = await startTestApp({ env: { APNS_ENVIRONMENTS: 'production' } });
    try {
      const now = local.clock.now();
      const insert = (token, environment, updatedAt) =>
        local.app.db.run('INSERT INTO devices (token, environment, created_at, updated_at) VALUES (?, ?, ?, ?)', token, environment, updatedAt, updatedAt);
      insert('a1'.repeat(32), 'sandbox', now - 31 * DAY);
      insert('a2'.repeat(32), 'sandbox', now - DAY);
      insert('a3'.repeat(32), 'production', now - 90 * DAY);
      await local.app.scheduler.tick();
      const left = local.app.db.all('SELECT token FROM devices ORDER BY token').map((row) => row.token);
      assert.deepEqual(left, ['a2'.repeat(32), 'a3'.repeat(32)]);
    } finally {
      await local.close();
    }
  });
});
