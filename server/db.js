// SQLite access (node:sqlite, synchronous). One connection per process; WAL
// lets the CLI write while the server is running. Schema changes are applied
// in order and tracked with PRAGMA user_version.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  // 1: initial schema (ARCHITECTURE.md §4)
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','scorekeeper')),
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client TEXT NOT NULL CHECK (client IN ('web','ios')),
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE INDEX sessions_expires ON sessions(expires_at);

  CREATE TABLE games (
    id TEXT PRIMARY KEY,
    sport TEXT NOT NULL,
    home_name TEXT NOT NULL, home_code TEXT NOT NULL, home_color TEXT NOT NULL,
    away_name TEXT NOT NULL, away_code TEXT NOT NULL, away_color TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    scheduled_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('scheduled','live','final','canceled')),
    period INTEGER NOT NULL DEFAULT 0,
    line TEXT NOT NULL DEFAULT '[]',
    outs INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    options TEXT NOT NULL DEFAULT '{}',
    clock_ms INTEGER,
    clock_anchor INTEGER,
    clock_running INTEGER NOT NULL DEFAULT 0,
    scorekeeper_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    channel_production TEXT,
    channel_sandbox TEXT,
    started_at INTEGER,
    ended_at INTEGER,
    created_by INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX games_status_scheduled ON games(status, scheduled_at);
  CREATE INDEX games_scheduled ON games(scheduled_at);
  CREATE INDEX games_scorekeeper ON games(scorekeeper_id);

  CREATE TABLE game_events (
    id INTEGER PRIMARY KEY,
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id INTEGER,
    action_id TEXT,
    type TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    prev_state TEXT,
    undone INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX game_events_action ON game_events(game_id, action_id) WHERE action_id IS NOT NULL;
  CREATE INDEX game_events_game ON game_events(game_id, id);

  CREATE TABLE devices (
    id INTEGER PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    environment TEXT NOT NULL CHECK (environment IN ('production','sandbox')),
    enabled INTEGER NOT NULL DEFAULT 1,
    activities_enabled INTEGER NOT NULL DEFAULT 1,
    app_version TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    invalid_at INTEGER,
    last_error TEXT
  );
  CREATE INDEX devices_targets ON devices(environment, enabled, invalid_at);

  CREATE TABLE push_log (
    id INTEGER PRIMARY KEY,
    game_id TEXT,
    kind TEXT NOT NULL,
    environment TEXT,
    sent INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    detail TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX push_log_created ON push_log(created_at);
  `,
  // 2: push state that must survive a restart (§8): per-game APNs timestamps
  // and push-to-start progress, end broadcasts not yet delivered, and
  // broadcast channels waiting to be deleted at Apple.
  `
  CREATE TABLE push_progress (
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    environment TEXT NOT NULL CHECK (environment IN ('production','sandbox')),
    last_timestamp INTEGER NOT NULL DEFAULT 0,
    start_pending INTEGER NOT NULL DEFAULT 0,
    start_cursor INTEGER NOT NULL DEFAULT 0,
    start_until INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (game_id, environment)
  );

  CREATE TABLE pending_ends (
    game_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    PRIMARY KEY (game_id, environment)
  );

  CREATE TABLE channel_cleanup (
    environment TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    game_id TEXT,
    delete_after INTEGER NOT NULL,
    PRIMARY KEY (environment, channel_id)
  );
  INSERT INTO channel_cleanup (environment, channel_id, game_id, delete_after)
    SELECT 'production', channel_production, id, COALESCE(ended_at, updated_at) + 21600000 FROM games
     WHERE status IN ('final', 'canceled') AND channel_production IS NOT NULL;
  INSERT INTO channel_cleanup (environment, channel_id, game_id, delete_after)
    SELECT 'sandbox', channel_sandbox, id, COALESCE(ended_at, updated_at) + 21600000 FROM games
     WHERE status IN ('final', 'canceled') AND channel_sandbox IS NOT NULL;
  `,
];

export class Database {
  #db;
  #statements = new Map();

  constructor(file, { busyTimeoutMs = 5000 } = {}) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
    this.file = file;
    this.#db = new DatabaseSync(file, { timeout: busyTimeoutMs, enableForeignKeyConstraints: true });
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#migrate();
  }

  get schemaVersion() {
    return this.#db.prepare('PRAGMA user_version').get().user_version;
  }

  get journalMode() {
    return this.#db.prepare('PRAGMA journal_mode').get().journal_mode;
  }

  #migrate() {
    const current = this.schemaVersion;
    if (current > MIGRATIONS.length) {
      throw new Error(`Database schema version ${current} is newer than this server (${MIGRATIONS.length}). Upgrade the server.`);
    }
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      this.transaction(() => {
        this.#db.exec(MIGRATIONS[version]);
        this.#db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  #statement(sql) {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  get(sql, ...params) {
    return this.#statement(sql).get(...params);
  }

  all(sql, ...params) {
    return this.#statement(sql).all(...params);
  }

  run(sql, ...params) {
    return this.#statement(sql).run(...params);
  }

  exec(sql) {
    this.#db.exec(sql);
  }

  // Runs `fn` inside BEGIN IMMEDIATE … COMMIT (rolled back if it throws).
  // Nested calls join the outer transaction. `fn` must be synchronous.
  transaction(fn) {
    if (this.#db.isTransaction) return fn();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        throw new Error('Database.transaction() callbacks must be synchronous');
      }
      this.#db.exec('COMMIT');
      return result;
    } catch (err) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  ping() {
    return this.#db.prepare('SELECT 1 AS ok').get().ok === 1;
  }

  get isOpen() {
    return this.#db.isOpen;
  }

  close() {
    if (!this.#db.isOpen) return;
    this.#statements.clear();
    this.#db.close();
  }
}

export function openDatabase(file, options) {
  return new Database(file, options);
}
