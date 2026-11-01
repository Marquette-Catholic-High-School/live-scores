import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ConfigError, PACKAGE_ROOT, loadConfig, readDotEnv } from '../server/config.js';

describe('config', () => {
  it('reads .env.example as the documented defaults', () => {
    const example = readDotEnv(path.join(PACKAGE_ROOT, '.env.example'));
    // An unquoted "#RRGGBB" would be parsed as a comment and silently dropped.
    assert.equal(example.HOME_TEAM_COLOR, '#12214D');
    const config = loadConfig(example, { dotenv: false });
    assert.deepEqual(config.homeTeam, { name: 'Marquette', code: 'MAR', color: '#12214D' });
    assert.equal(config.dataDir, path.join(PACKAGE_ROOT, 'data'));
    assert.deepEqual([...config.apns.environments], ['production', 'sandbox']);
    assert.equal(config.apns.credentialsPresent, false);
    assert.equal(config.apns.minUpdateIntervalMs, 5000);
    assert.equal(config.timeZone, 'America/Chicago');
    assert.deepEqual({ ...config.limits }, { sseMaxPerIp: 2000, sseMaxConnections: 20_000, rateLimitPerMinute: 3000, deviceRateLimitPerMinute: 600 });
    for (const key of ['SSE_MAX_PER_IP', 'SSE_MAX_CONNECTIONS', 'RATE_LIMIT_PER_MINUTE', 'DEVICE_RATE_LIMIT_PER_MINUTE', 'SCHOOL_TIMEZONE']) {
      assert.ok(key in example, `${key} is documented in .env.example`);
    }
  });

  it('defaults the per-client limits and the school time zone', () => {
    const config = loadConfig({}, { dotenv: false });
    assert.deepEqual({ ...config.limits }, { sseMaxPerIp: 2000, sseMaxConnections: 20_000, rateLimitPerMinute: 3000, deviceRateLimitPerMinute: 600 });
    assert.equal(config.timeZone, 'America/Chicago');
    const custom = loadConfig({ SSE_MAX_PER_IP: '500', SSE_MAX_CONNECTIONS: '6000', RATE_LIMIT_PER_MINUTE: '1200', DEVICE_RATE_LIMIT_PER_MINUTE: '60', SCHOOL_TIMEZONE: 'America/New_York' }, { dotenv: false });
    assert.deepEqual({ ...custom.limits }, { sseMaxPerIp: 500, sseMaxConnections: 6000, rateLimitPerMinute: 1200, deviceRateLimitPerMinute: 60 });
    assert.equal(custom.timeZone, 'America/New_York');
    assert.throws(
      () => loadConfig({ SSE_MAX_PER_IP: '0', SSE_MAX_CONNECTIONS: 'lots', RATE_LIMIT_PER_MINUTE: '-5', DEVICE_RATE_LIMIT_PER_MINUTE: '1.5', SCHOOL_TIMEZONE: 'Central' }, { dotenv: false }),
      (err) =>
        err instanceof ConfigError &&
        ['SSE_MAX_PER_IP', 'SSE_MAX_CONNECTIONS', 'RATE_LIMIT_PER_MINUTE', 'DEVICE_RATE_LIMIT_PER_MINUTE', 'SCHOOL_TIMEZONE'].every((key) =>
          err.problems.some((problem) => problem.startsWith(key)),
        ),
    );
  });

  it('rejects invalid values with every problem listed', () => {
    assert.throws(
      () => loadConfig({ PORT: 'eighty', HOME_TEAM_COLOR: 'navy', APNS_ENVIRONMENTS: 'staging' }, { dotenv: false }),
      (err) =>
        err instanceof ConfigError &&
        ['PORT', 'HOME_TEAM_COLOR', 'unknown environment "staging"', 'must list production'].every((needle) =>
          err.problems.some((problem) => problem.includes(needle)),
        ),
    );
  });
});
