import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { hexToken, startTestApp } from './helpers.js';

describe('POST /api/devices', () => {
  let t;
  before(async () => {
    t = await startTestApp({ env: { DEVICE_RATE_LIMIT_PER_MINUTE: '30' }, appOptions: { deviceRateLimitPerMinute: undefined } });
  });
  after(() => t.close());

  const row = (token) => t.app.db.get('SELECT * FROM devices WHERE token = ?', token);

  it('upserts by token and clears invalid_at', async () => {
    const token = hexToken('device-one');
    const first = await t.client().post('/api/devices', { token: token.toUpperCase(), environment: 'sandbox', enabled: true, activitiesEnabled: true, appVersion: '5.0 (12)' });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json.ok, true);
    assert.equal(typeof first.json.serverTime, 'number');
    let device = row(token);
    assert.deepEqual([device.environment, device.enabled, device.activities_enabled, device.app_version], ['sandbox', 1, 1, '5.0 (12)']);

    t.app.db.run("UPDATE devices SET invalid_at = 1, last_error = 'Unregistered' WHERE token = ?", token);
    await t.client().post('/api/devices', { token, environment: 'production', enabled: false, activitiesEnabled: false, appVersion: '5.1' });
    device = row(token);
    assert.deepEqual([device.environment, device.enabled, device.activities_enabled, device.app_version, device.invalid_at, device.last_error], ['production', 0, 0, '5.1', null, null]);
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM devices WHERE token = ?', token).n, 1);
  });

  it('keeps a token APNs rejected as malformed invalid when it is registered again', async () => {
    const junk = hexToken('junk-token');
    await t.client().post('/api/devices', { token: junk, environment: 'production', enabled: true });
    t.app.db.run("UPDATE devices SET invalid_at = 5, last_error = 'BadDeviceToken' WHERE token = ?", junk);
    assert.equal((await t.client().post('/api/devices', { token: junk, environment: 'production', enabled: true, appVersion: '9' })).status, 200);
    let device = row(junk);
    assert.deepEqual([device.invalid_at, device.last_error, device.app_version], [5, 'BadDeviceToken', '9']);
    // In the other environment the same token may be valid (it was sent to the wrong one).
    await t.client().post('/api/devices', { token: junk, environment: 'sandbox', enabled: true });
    device = row(junk);
    assert.deepEqual([device.environment, device.invalid_at, device.last_error], ['sandbox', null, null]);
  });

  it('replaces previousToken', async () => {
    const oldToken = hexToken('old-token');
    const newToken = hexToken('new-token');
    await t.client().post('/api/devices', { token: oldToken, environment: 'production', enabled: true });
    const res = await t.client().post('/api/devices', { token: newToken, previousToken: oldToken, environment: 'production', enabled: true });
    assert.equal(res.status, 200);
    assert.equal(row(oldToken), undefined);
    assert.ok(row(newToken));
    assert.equal(row(newToken).activities_enabled, 1, 'activitiesEnabled defaults to true');
  });

  it('validates input', async () => {
    const valid = { token: hexToken('valid'), environment: 'production', enabled: true };
    const cases = [
      { ...valid, token: 'abc' },
      { ...valid, token: 'zz'.repeat(20) },
      { ...valid, token: 'a'.repeat(514) },
      { ...valid, token: 12345 },
      { ...valid, environment: 'staging' },
      { ...valid, enabled: 'true' },
      { token: valid.token, environment: 'production' },
      { ...valid, activitiesEnabled: 1 },
      { ...valid, appVersion: 'x'.repeat(33) },
      { ...valid, previousToken: 'nothex' },
    ];
    for (const body of cases) {
      const res = await t.client().post('/api/devices', body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      assert.equal(res.json.error.code, 'bad_request');
    }
  });

  it('rate-limits registrations per IP (DEVICE_RATE_LIMIT_PER_MINUTE)', async () => {
    const client = t.client({ forwardedFor: '203.0.113.50' });
    for (let i = 0; i < 30; i += 1) {
      const res = await client.post('/api/devices', { token: hexToken(`rate-${i}`), environment: 'production', enabled: true });
      assert.equal(res.status, 200);
    }
    const limited = await client.post('/api/devices', { token: hexToken('rate-x'), environment: 'production', enabled: true });
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error.code, 'rate_limited');
    assert.equal((await t.client({ forwardedFor: '203.0.113.51' }).post('/api/devices', { token: hexToken('rate-y'), environment: 'production', enabled: true })).status, 200);
    t.clock.advance(61_000);
    assert.equal((await client.post('/api/devices', { token: hexToken('rate-z'), environment: 'production', enabled: true })).status, 200);
  });
});
