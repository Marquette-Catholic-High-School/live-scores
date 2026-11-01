// Environment configuration (ARCHITECTURE.md §3). Values come from the process
// environment; in development an optional `.env` file next to package.json
// fills in keys the environment does not set. Unknown keys are ignored.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { LOG_LEVELS } from './log.js';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APNS_ENVIRONMENT_NAMES = Object.freeze(['production', 'sandbox']);

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export function readDotEnv(file = path.join(PACKAGE_ROOT, '.env')) {
  if (!existsSync(file)) return {};
  return parseEnv(readFileSync(file, 'utf8'));
}

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function loadConfig(env = process.env, { dotenv = true, publicDir } = {}) {
  const source = dotenv ? { ...readDotEnv(), ...env } : { ...env };
  const problems = [];

  const raw = (key) => {
    const value = source[key];
    if (value === undefined || value === null) return undefined;
    const trimmed = String(value).trim();
    return trimmed === '' ? undefined : trimmed;
  };
  const text = (key, fallback) => raw(key) ?? fallback;
  const integer = (key, fallback, min, max) => {
    const value = raw(key);
    if (value === undefined) return fallback;
    if (!/^-?\d+$/.test(value) || Number(value) < min || Number(value) > max) {
      problems.push(`${key} must be an integer between ${min} and ${max} (got "${value}")`);
      return fallback;
    }
    return Number(value);
  };
  const number = (key, fallback, min, max) => {
    const value = raw(key);
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) {
      problems.push(`${key} must be a number between ${min} and ${max} (got "${value}")`);
      return fallback;
    }
    return n;
  };
  const boolean = (key, fallback) => {
    const value = raw(key);
    if (value === undefined) return fallback;
    const lower = value.toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
    if (['0', 'false', 'no', 'off'].includes(lower)) return false;
    problems.push(`${key} must be 0 or 1 (got "${value}")`);
    return fallback;
  };
  const resolvePath = (value) => (path.isAbsolute(value) ? value : path.resolve(PACKAGE_ROOT, value));

  const host = text('HOST', '127.0.0.1');
  const port = integer('PORT', 8080, 0, 65535);
  const publicUrl = text('PUBLIC_URL', 'http://localhost:8080').replace(/\/+$/, '');
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
  } catch {
    problems.push(`PUBLIC_URL must be an http(s) URL (got "${publicUrl}")`);
  }

  const dataDir = resolvePath(text('DATA_DIR', './data'));
  const trustProxy = boolean('TRUST_PROXY', true);
  const schoolName = text('SCHOOL_NAME', 'Marquette Catholic');

  const homeName = text('HOME_TEAM_NAME', 'Marquette');
  if (homeName.length > 40) problems.push('HOME_TEAM_NAME must be at most 40 characters');
  const homeCode = text('HOME_TEAM_CODE', 'MAR').toUpperCase();
  if (!/^[A-Z0-9]{2,4}$/.test(homeCode)) problems.push(`HOME_TEAM_CODE must be 2–4 letters/digits (got "${homeCode}")`);
  const homeColor = text('HOME_TEAM_COLOR', '#12214D').toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(homeColor)) problems.push(`HOME_TEAM_COLOR must be #RRGGBB (got "${homeColor}")`);

  const startWindowMinutes = integer('START_WINDOW_MINUTES', 120, 0, 10080);
  const autoFinalHours = number('AUTO_FINAL_HOURS', 4, 0.1, 168);

  const timeZone = text('SCHOOL_TIMEZONE', 'America/Chicago');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    problems.push(`SCHOOL_TIMEZONE must be an IANA time zone such as America/Chicago (got "${timeZone}")`);
  }

  // Per-client limits. Fans at a game usually share one school or carrier
  // NAT address, so these are generous; signed-in staff are exempt from the
  // general API limit, and sign-in has its own failure throttling.
  const sseMaxPerIp = integer('SSE_MAX_PER_IP', 2000, 1, 1_000_000);
  const sseMaxConnections = integer('SSE_MAX_CONNECTIONS', 20_000, 1, 1_000_000);
  const rateLimitPerMinute = integer('RATE_LIMIT_PER_MINUTE', 3000, 1, 1_000_000);
  const deviceRateLimitPerMinute = integer('DEVICE_RATE_LIMIT_PER_MINUTE', 600, 1, 1_000_000);

  const teamId = raw('APNS_TEAM_ID')?.toUpperCase();
  const keyId = raw('APNS_KEY_ID')?.toUpperCase();
  const keyPathRaw = raw('APNS_KEY_PATH');
  if (teamId && !/^[A-Z0-9]{10}$/.test(teamId)) problems.push(`APNS_TEAM_ID must be the 10-character Team ID (got "${teamId}")`);
  if (keyId && !/^[A-Z0-9]{10}$/.test(keyId)) problems.push(`APNS_KEY_ID must be the 10-character Key ID (got "${keyId}")`);
  const bundleId = text('APNS_BUNDLE_ID', 'org.marquettecatholic.app');
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(bundleId)) problems.push(`APNS_BUNDLE_ID is not a valid bundle id (got "${bundleId}")`);

  const environments = [];
  for (const part of text('APNS_ENVIRONMENTS', 'production,sandbox').split(',')) {
    const env = part.trim().toLowerCase();
    if (!env) continue;
    if (!APNS_ENVIRONMENT_NAMES.includes(env)) problems.push(`APNS_ENVIRONMENTS contains unknown environment "${env}"`);
    else if (!environments.includes(env)) environments.push(env);
  }
  if (environments.length === 0) problems.push('APNS_ENVIRONMENTS must list production and/or sandbox');

  const channelStoragePolicy = integer('APNS_CHANNEL_STORAGE_POLICY', 0, 0, 1);
  const minUpdateIntervalMs = integer('APNS_MIN_UPDATE_INTERVAL_MS', 5000, 0, 60000);

  const logLevel = text('LOG_LEVEL', 'info').toLowerCase();
  if (!(logLevel in LOG_LEVELS)) problems.push(`LOG_LEVEL must be debug, info, warn or error (got "${logLevel}")`);

  if (problems.length) throw new ConfigError(problems);

  const keyPath = keyPathRaw ? resolvePath(keyPathRaw) : undefined;
  return Object.freeze({
    host,
    port,
    publicUrl,
    dataDir,
    dbPath: path.join(dataDir, 'live.db'),
    trustProxy,
    schoolName,
    homeTeam: Object.freeze({ name: homeName, code: homeCode, color: homeColor }),
    startWindowMinutes,
    autoFinalHours,
    timeZone,
    limits: Object.freeze({ sseMaxPerIp, sseMaxConnections, rateLimitPerMinute, deviceRateLimitPerMinute }),
    apns: Object.freeze({
      teamId,
      keyId,
      keyPath,
      bundleId,
      environments: Object.freeze(environments),
      channelStoragePolicy,
      minUpdateIntervalMs,
      credentialsPresent: Boolean(teamId && keyId && keyPath),
    }),
    logLevel,
    version: readPackageVersion(),
    packageRoot: PACKAGE_ROOT,
    publicDir: publicDir ?? path.join(PACKAGE_ROOT, 'public'),
  });
}
