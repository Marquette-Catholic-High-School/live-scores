import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PASSWORD, createGame, startTestApp } from './helpers.js';

describe('users admin', () => {
  let t;
  let admin;
  let adminUser;
  before(async () => {
    t = await startTestApp();
    adminUser = await t.createUser('boss', 'admin', 'Boss');
    admin = t.client();
    await admin.loginWeb('boss');
  });
  after(() => t.close());

  it('is admin-only', async () => {
    const keeper = await t.signedIn('plain-keeper');
    assert.equal((await keeper.get('/api/users')).status, 403);
    assert.equal((await keeper.post('/api/users', { username: 'x1x', displayName: 'X', password: PASSWORD, role: 'admin' })).status, 403);
    assert.equal((await t.client().get('/api/users')).status, 401);
  });

  it('creates, lists and validates users', async () => {
    const res = await admin.post('/api/users', { username: 'New.User', displayName: ' Coach New ', password: PASSWORD, role: 'scorekeeper' });
    assert.equal(res.status, 200);
    assert.equal(res.json.user.username, 'new.user');
    assert.equal(res.json.user.displayName, 'Coach New');
    assert.equal(res.json.user.role, 'scorekeeper');
    assert.equal(res.json.user.disabled, false);
    assert.equal(typeof res.json.user.createdAt, 'number');

    assert.equal((await admin.post('/api/users', { username: 'NEW.user', displayName: 'Dup', password: PASSWORD, role: 'scorekeeper' })).status, 409);
    assert.equal((await admin.post('/api/users', { username: 'ab', displayName: 'Short', password: PASSWORD, role: 'scorekeeper' })).status, 400);
    assert.equal((await admin.post('/api/users', { username: 'bad name', displayName: 'Bad', password: PASSWORD, role: 'scorekeeper' })).status, 400);
    assert.equal((await admin.post('/api/users', { username: 'okname', displayName: 'Ok', password: 'short', role: 'scorekeeper' })).status, 400);
    assert.equal((await admin.post('/api/users', { username: 'okname', displayName: 'Ok', password: PASSWORD, role: 'owner' })).status, 400);
    assert.equal((await admin.post('/api/users', { username: 'okname', displayName: '', password: PASSWORD, role: 'admin' })).status, 400);

    const list = await admin.get('/api/users');
    const listed = list.json.users.find((u) => u.username === 'new.user');
    assert.deepEqual(Object.keys(listed).sort(), ['createdAt', 'disabled', 'displayName', 'id', 'role', 'username']);
  });

  it('protects the acting admin from demoting, disabling or deleting themself', async () => {
    const id = adminUser.id;
    const demote = await admin.patch(`/api/users/${id}`, { role: 'scorekeeper' });
    assert.equal(demote.status, 409);
    assert.equal(demote.json.error.code, 'conflict');
    assert.equal((await admin.patch(`/api/users/${id}`, { disabled: true })).status, 409);
    assert.equal((await admin.delete(`/api/users/${id}`)).status, 409);
    const rename = await admin.patch(`/api/users/${id}`, { displayName: 'Big Boss' });
    assert.equal(rename.status, 200);
    assert.equal(rename.json.user.displayName, 'Big Boss');
  });

  it('keeps at least one enabled admin', async () => {
    const other = await t.createUser('second-admin', 'admin');
    // Another admin may be demoted while one enabled admin remains.
    assert.equal((await admin.patch(`/api/users/${other.id}`, { role: 'scorekeeper' })).status, 200);
    // From the CLI (no acting user) the last enabled admin can't be removed.
    await assert.rejects(t.app.users.update(adminUser.id, { role: 'scorekeeper' }), { status: 409 });
    await assert.rejects(t.app.users.update(adminUser.id, { disabled: true }), { status: 409 });
    assert.throws(() => t.app.users.delete(adminUser.id), { status: 409 });
    // A disabled admin doesn't count.
    await t.app.users.update(other.id, { role: 'admin', disabled: true });
    assert.throws(() => t.app.users.delete(adminUser.id), { status: 409 });
    await t.app.users.update(other.id, { disabled: false });
    t.app.users.delete(other.id);
  });

  it('revokes sessions when disabling a user or setting their password', async () => {
    const keeper = await t.signedIn('revokee', 'scorekeeper', { ios: true });
    const user = t.app.users.getByUsername('revokee');
    assert.equal((await admin.patch(`/api/users/${user.id}`, { password: 'another-password' })).status, 200);
    assert.equal((await keeper.get('/api/auth/me')).status, 401);
    await keeper.loginIos('revokee', 'another-password');
    assert.equal((await admin.patch(`/api/users/${user.id}`, { disabled: true })).status, 200);
    assert.equal((await keeper.get('/api/auth/me')).status, 401);
    assert.equal((await t.client().post('/api/auth/login', { username: 'revokee', password: 'another-password', client: 'ios' })).status, 403);
    assert.equal((await admin.patch(`/api/users/${user.id}`, { disabled: 'yes' })).status, 400);
  });

  it('deletes users and unassigns their games', async () => {
    const keeper = await t.signedIn('leaver');
    const user = t.app.users.getByUsername('leaver');
    const game = await createGame(admin);
    assert.equal((await keeper.post(`/api/games/${game.id}/claim`, {})).json.game.scorekeeper.id, user.id);
    const res = await admin.delete(`/api/users/${user.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.ok, true);
    assert.equal((await keeper.get('/api/auth/me')).status, 401);
    assert.equal((await admin.get(`/api/games/${game.id}`)).json.game.scorekeeper, null);
    assert.equal((await admin.delete(`/api/users/${user.id}`)).status, 404);
    assert.equal((await admin.patch('/api/users/abc', { displayName: 'x' })).status, 404);
  });
});
