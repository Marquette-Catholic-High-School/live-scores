# MCHS Live Scores — Architecture & API Contract

This document is the single source of truth for the live-score system. The server
(`server/`), the web portal (`public/`) and the deploy scripts (`deploy/`) - the
`web-portal` folder of the app project, published as
[live-scores](https://github.com/Marquette-Catholic-High-School/live-scores) - and the
iOS app (`MCHS/`, `MCHSWidget/` in the app project) are all built against it. If code and this document disagree, fix one of them — don't let
them drift.

## 1. What it does

1. An **admin** schedules games (sport, teams, time, location) in the web portal.
2. A **scorekeeper** signs in (web portal or the iOS app), claims a game, and at
   game time taps **Start game**.
3. The server immediately **starts a Live Activity on every iPhone that has
   "Sports Updates" turned on** (APNs push-to-start), each one subscribed to an
   APNs **broadcast channel** for that game.
4. Every score / period / clock change the scorekeeper makes is sent as **one
   broadcast push** to that channel, so every Lock Screen and Dynamic Island
   updates within a second or two, no matter how many fans there are.
5. The web portal's public scoreboard and the app's Scores screen update live via
   **Server-Sent Events**.
6. **End game** pushes the final score and the Live Activity dismisses itself
   two hours later. Live games nobody has changed for `AUTO_FINAL_HOURS` are ended automatically.

Firebase is **not** used by any part of this system. The rest of the iOS app
(accounts, photographer scheduler, Photo Drop, FCM announcements) stays on
Firebase and is untouched; the only touch point is the existing "Sports Updates"
toggle, which now also opts the device in/out of game Live Activities.

## 2. Components

```
            ┌──────────────── VM (Ubuntu 24.04/26.04 LTS) ─────────────────┐
 Internet   │                                                              │
 :80/:443 ──┼─► Caddy (TLS, Let's Encrypt, HTTP/3) ──► Node 24 :8080 (127.0.0.1)
            │                                         ├─ REST API  /api/*    │
            │                                         ├─ SSE       /api/stream
            │                                         ├─ static    public/*  │
            │                                         ├─ SQLite    /var/lib/mchs-live/live.db
            │                                         └─ APNs HTTP/2 client ─┼──► Apple (outbound)
            └──────────────────────────────────────────────────────────────┘
```

* **Server**: Node.js ≥ 24 (production installs Node 26 LTS), ES modules, **zero npm
  dependencies** (`node:http`, `node:http2`, `node:crypto`, `node:sqlite`). One process.
* **Database**: SQLite via `node:sqlite` (`import { DatabaseSync }` — works on 24 and 26),
  WAL mode, `BEGIN IMMEDIATE`/`COMMIT` transactions, file
  `${DATA_DIR}/live.db`. Schema migrations keyed on `PRAGMA user_version`.
* **Web portal**: static HTML/CSS/vanilla JS in `public/`, no build step, no
  third-party CDNs, served by the Node server.
* **Reverse proxy**: Caddy terminates TLS (automatic Let's Encrypt) and proxies
  to `127.0.0.1:8080`. Node never listens on a public interface. Alternative
  (`install.sh --cloudflare-tunnel`): no Caddy and no inbound ports; `cloudflared`
  (service `mchs-live-tunnel`) holds outbound connections to Cloudflare, which
  terminates TLS and forwards to `http://127.0.0.1:8080`. Both set
  `X-Forwarded-For` (the client is the last hop) and `X-Forwarded-Proto`.
* **Scoreboard feed** (optional, §11): while a basketball or volleyball game with the
  school's team at home is live, the server reads the gym's Daktronics All Sport 5000
  scoreboard through its Lantronix serial-to-Ethernet box (TCP client, read-only) and keeps
  the game's score, clock and period in step.
* **iOS**: SwiftUI app + WidgetKit extension. ActivityKit (iOS 18+ — the app's
  deployment target is 18.6, so broadcast channels are always available).

## 3. Configuration (environment)

Loaded from `/etc/mchs-live/mchs-live.env` by systemd in production; from the
process environment (or a `.env` file next to `package.json`, if present) in
development. Unknown keys are ignored. Write values in double quotes: a value
containing `#` (e.g. `HOME_TEAM_COLOR="#12214D"`) **must** be quoted, otherwise the
`.env` / `--env-file` parser reads the `#` as the start of a comment. The installer
quotes every value it writes.

| Key | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address |
| `PORT` | `8080` | Listen port |
| `PUBLIC_URL` | `http://localhost:8080` | External base URL (used in logs / links) |
| `DATA_DIR` | `./data` | Directory for `live.db` |
| `TRUST_PROXY` | `1` | Trust `X-Forwarded-For` / `X-Forwarded-Proto` when the peer is loopback |
| `SCHOOL_NAME` | `Marquette Catholic` | Shown in the portal header |
| `HOME_TEAM_NAME` | `Marquette` | Default home team for new games |
| `HOME_TEAM_CODE` | `MAR` | Default home code (2–4 chars) |
| `HOME_TEAM_COLOR` | `#12214D` | Default home color |
| `START_WINDOW_MINUTES` | `120` | Scorekeepers may start a game no earlier than this many minutes before `scheduledAt` (admins: any time) |
| `AUTO_FINAL_HOURS` | `4` | Live games nobody has changed for this many hours (measured from the game's `updatedAt`) are ended automatically |
| `SCHOOL_TIMEZONE` | `America/Chicago` | IANA time zone of the school (must be known to Node's `Intl`), returned by `GET /api/config` as `timeZone` |
| `APNS_TEAM_ID` | — | Apple Developer Team ID (`92KVHUHC4C`) |
| `APNS_KEY_ID` | — | Key ID of the APNs auth key (.p8) |
| `APNS_KEY_PATH` | — | Path to the `.p8` file |
| `APNS_BUNDLE_ID` | `org.marquettecatholic.app` | App bundle id (topic) |
| `APNS_ENVIRONMENTS` | `production,sandbox` | Which APNs environments to serve. Devices register with their environment; channels are created per environment |
| `APNS_CHANNEL_STORAGE_POLICY` | `0` | Broadcast channel message storage policy (0 = No Message Stored, 1 = Most Recent Message Stored) |
| `APNS_MIN_UPDATE_INTERVAL_MS` | `5000` | Base minimum interval between broadcast updates per game (adaptive on 429) |
| `SSE_MAX_PER_IP` | `2000` | Concurrent `/api/stream` connections per client address (§7.1) |
| `SSE_MAX_CONNECTIONS` | `20000` | Concurrent `/api/stream` connections in total; the systemd unit's `LimitNOFILE` is kept above it (≥ 65536) |
| `RATE_LIMIT_PER_MINUTE` | `3000` | `/api/*` requests per client address per minute without a valid session (signed-in staff are not counted) |
| `DEVICE_RATE_LIMIT_PER_MINUTE` | `600` | `POST /api/devices` requests per client address per minute |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

"Client address" = the client IP (behind Caddy or a Cloudflare Tunnel: the last
`X-Forwarded-For` hop, which the proxy appends itself); IPv6 clients
are grouped per /64. The per-address limits are deliberately high: at a big game,
hundreds of fans on the school Wi-Fi (or behind one mobile carrier's NAT) share a
single public address and open the scoreboard at the same moment.

Every value is validated at startup (`server/config.js`): e.g. `PORT` 0–65535,
`START_WINDOW_MINUTES` 0–10080, `AUTO_FINAL_HOURS` 0.1–168, the four capacity limits
(`SSE_MAX_PER_IP` … `DEVICE_RATE_LIMIT_PER_MINUTE`) 1–1 000 000, `APNS_CHANNEL_STORAGE_POLICY` 0|1,
`APNS_MIN_UPDATE_INTERVAL_MS` 0–60 000, `TRUST_PROXY` 1/0 (also true/false, yes/no,
on/off). An invalid value stops the server with `Invalid configuration` and the list
of bad keys.

If any `APNS_*` credential is missing (or the key can't be loaded) the server still
runs; pushes are skipped and `/api/health` reports `apns.configured: false`.

## 4. Data model (SQLite)

All timestamps are **Unix milliseconds** (`INTEGER`) in the database and the REST
API. (Live Activity payloads use Unix **seconds** — see §8.)

```sql
users(
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- 3–32 chars [a-z0-9._-]
  display_name TEXT NOT NULL,                      -- 1–60 chars
  password_hash TEXT NOT NULL,                     -- scrypt$N$r$p$saltB64$hashB64
  role TEXT NOT NULL CHECK (role IN ('admin','scorekeeper')),
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)
sessions(
  id TEXT PRIMARY KEY,               -- hex SHA-256 of the session token (raw token never stored)
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client TEXT NOT NULL,              -- 'web' | 'ios'
  created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
)
games(
  id TEXT PRIMARY KEY,               -- 10 chars from 'abcdefghjkmnpqrstuvwxyz23456789'
  sport TEXT NOT NULL,               -- key in sports.js
  home_name TEXT NOT NULL, home_code TEXT NOT NULL, home_color TEXT NOT NULL,
  away_name TEXT NOT NULL, away_code TEXT NOT NULL, away_color TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled','live','final','canceled')),
  period INTEGER NOT NULL DEFAULT 0, -- 0-based index (see §5)
  line TEXT NOT NULL DEFAULT '[]',   -- JSON [{ "home": n, "away": n }, …] one entry per period reached
  outs INTEGER NOT NULL DEFAULT 0,   -- baseball only
  note TEXT NOT NULL DEFAULT '',     -- short status line, ≤ 40 chars ("Halftime", "Timeout")
  options TEXT NOT NULL DEFAULT '{}',-- JSON per-game options: { clockEnabled, periodMinutes, overtimeMinutes, bestOf }
  clock_ms INTEGER,                  -- remaining ms as of clock_anchor (NULL = no clock this period)
  clock_anchor INTEGER,              -- unix ms when clock_ms was recorded
  clock_running INTEGER NOT NULL DEFAULT 0,
  scorekeeper_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  channel_production TEXT, channel_sandbox TEXT,   -- APNs broadcast channel ids
  started_at INTEGER, ended_at INTEGER,
  created_by INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, -- +1 on every state change
  scoreboard TEXT NOT NULL DEFAULT 'default',   -- schema 3, §11: 'default' | 'off' | '<ip>:<port>'
  scoreboard_manual INTEGER NOT NULL DEFAULT 0  -- schema 3, §11: 1 = the scorekeeper scores this game by hand
)
game_events(
  id INTEGER PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id INTEGER, action_id TEXT,   -- client-supplied idempotency key (UNIQUE per game when not NULL)
  type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
  prev_state TEXT,                   -- JSON snapshot of the scoring state before this action (for undo)
  undone INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)
devices(
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,        -- push-to-start token, lowercase hex
  environment TEXT NOT NULL CHECK (environment IN ('production','sandbox')),
  enabled INTEGER NOT NULL DEFAULT 1,-- "Sports Updates" on
  activities_enabled INTEGER NOT NULL DEFAULT 1, -- ActivityAuthorizationInfo().areActivitiesEnabled
  app_version TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  invalid_at INTEGER, last_error TEXT
)
push_log(
  id INTEGER PRIMARY KEY, game_id TEXT, kind TEXT NOT NULL,   -- 'start' | 'update' | 'end' | 'channel'
  environment TEXT, sent INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
)
-- schema version 2: push state that must survive a restart (§8):
push_progress(                       -- PRIMARY KEY (game_id, environment)
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  environment TEXT NOT NULL,         -- 'production' | 'sandbox'
  last_timestamp INTEGER NOT NULL DEFAULT 0,  -- last aps.timestamp sent (§8.4)
  start_pending INTEGER NOT NULL DEFAULT 0,   -- 1 = push-to-start fan-out not finished (§8.1)
  start_cursor INTEGER NOT NULL DEFAULT 0,    -- devices.id the fan-out has claimed up to
  start_until INTEGER NOT NULL DEFAULT 0      -- MAX(devices.id) when the game started
)
pending_ends(                        -- PRIMARY KEY (game_id, environment); no foreign key: survives deleting the game
  game_id, environment, channel_id, payload,  -- the end broadcast, built when the game ended (§8.3)
  detail, created_at, next_attempt_at
)
channel_cleanup(                     -- PRIMARY KEY (environment, channel_id)
  environment, channel_id, game_id,
  delete_after INTEGER NOT NULL      -- when the scheduler may delete the channel at Apple (§8.3)
)
-- schema version 3: the scoreboard feed (§11):
settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)  -- 'scoreboard.defaultAddress'
```

The schema version is `PRAGMA user_version` (currently **3**). Migrations run at startup,
each in one transaction; migration 2 also queues the channels of games that had already
ended for deletion. A database with a newer version than the server knows is refused
(an older server can't open a database a newer one has migrated).

Keep only the last 30 days of `push_log`; delete sessions after expiry; devices
marked invalid for > 30 days are deleted, and so are devices registered for an
environment the server no longer serves (not in `APNS_ENVIRONMENTS`) that haven't
re-registered for 30 days. (Housekeeping runs in the scheduler.)

## 5. Sports (data-driven)

`server/sports.js` exports `SPORTS`, an object keyed by sport id. Everything a
client needs to render a scoreboard or a scoring pad comes from here (exposed by
`GET /api/sports` and embedded per game as `rules`). Adding a sport (e.g.
softball) must require **no client changes**.

```js
{
  basketball: {
    name: 'Basketball', symbol: 'basketball.fill',      // SF Symbol name for iOS
    scoreMode: 'points',                                // 'points' | 'sets'
    periods: [ { label: '1st Quarter', short: 'Q1' }, { label: '2nd Quarter', short: 'Q2' },
               { label: '3rd Quarter', short: 'Q3' }, { label: '4th Quarter', short: 'Q4' } ],
    overtime: { label: 'Overtime', short: 'OT', max: null, naming: 'prefix' },   // OT, 2OT, 3OT… (max null = unlimited)
    scoring: [ { points: 1, label: '+1' }, { points: 2, label: '+2' }, { points: 3, label: '+3' } ],
    clock: { available: true, defaultEnabled: true, periodMinutes: 8, overtimeMinutes: 4 },
    notes: ['Timeout', 'Halftime', 'End of Quarter'],
  },
  football: {
    name: 'Football', symbol: 'football.fill', scoreMode: 'points',
    periods: Q1–Q4 as basketball,
    overtime: { label: 'Overtime', short: 'OT', max: null, naming: 'prefix' },
    scoring: [ {6,'TD'}, {3,'FG'}, {1,'PAT'}, {2,'2-PT'}, {2,'Safety'} ],
    clock: { available: true, defaultEnabled: true, periodMinutes: 12, overtimeMinutes: 0 },
    notes: ['Timeout', 'Halftime', 'End of Quarter', 'Injury'],
  },
  soccer: {
    name: 'Soccer', symbol: 'soccerball', scoreMode: 'points',
    periods: [ { label: '1st Half', short: '1H' }, { label: '2nd Half', short: '2H' } ],
    overtime: { label: 'Overtime', short: 'OT', max: 2, naming: 'suffix' },     // OT1, OT2
    scoring: [ { points: 1, label: 'Goal' } ],
    clock: { available: true, defaultEnabled: true, periodMinutes: 40, overtimeMinutes: 10 },
    notes: ['Halftime', 'Injury', 'Weather Delay', 'Penalty Kicks'],
  },
  volleyball: {
    name: 'Volleyball', symbol: 'volleyball.fill', scoreMode: 'sets',
    periods: generated from options.bestOf (3 or 5, default 3): { label: 'Set N', short: 'S N' } — no overtime,
    overtime: null,
    scoring: [ { points: 1, label: 'Point' } ],
    clock: { available: false },
    notes: ['Timeout', 'Between Sets'],
    defaults: { bestOf: 3 },
  },
  baseball: {
    name: 'Baseball', symbol: 'baseball.fill', scoreMode: 'points', tracksOuts: true,
    periods: half-innings for 7 innings: index 0 = { label: 'Top 1st', short: '▲1' }, 1 = { label: 'Bottom 1st', short: '▼1' } …
    overtime: { label: 'Extra Innings', short: 'XI', max: null, naming: 'innings' },   // Top 8th ▲8 …
    scoring: [ { points: 1, label: 'Run' } ],
    clock: { available: false },
    notes: ['Pitching Change', 'Rain Delay', 'Mid-Inning'],
  },
}
```

Helpers (server only) — `periodInfo(sportId, options, index) → { label, short, isOvertime }`,
`periodCount(sportId, options)` (regulation count), `maxPeriodIndex(...)` (null = unlimited),
`periodClockMinutes(...)` (0/undefined → no clock for that period).
Overtime naming is data too — `overtime.naming` (sent to clients in `rules`, so they can
name periods the same way the server does): `'prefix'` = `OT`, `2OT`, `3OT` (label
`Overtime`, `2nd Overtime` …; basketball, football); `'suffix'` = `OT1`, `OT2` (label
`Overtime 1`, `Overtime 2`; soccer); `'innings'` = the regulation pattern continues
(baseball half-innings `Top 8th` / `▲8` …). Missing = `'prefix'`.
Ordinals: 1st 2nd 3rd 4th … 11th 12th 13th … 21st.

**Scores.**
* `line[i]` holds the points scored *in* period `i`. A `score` action adds to `line[period]`;
  in points mode a minus larger than the team's points in the current period takes the
  rest off the earlier periods (a mistake noticed after the period moved on).
* `scoreMode: 'points'` → team score = sum of `line`.
* `scoreMode: 'sets'` (volleyball) → team score = sets won = number of *completed*
  sets (`i < period`) where that team's `line[i]` is higher; the current set's
  points are `line[period]`. If the game is `final`, the current set also counts
  as completed (if it has a winner).
* Baseball `outs` (0–2): `+1` on two outs → outs reset to 0 **and** the period
  advances to the next half-inning automatically. `−1` at 0 outs → 409.

**Game clock** (only when the sport has `clock.available` and the game's
`options.clockEnabled`). The server stores `clock_ms` (remaining) + `clock_anchor`
+ `clock_running`. Current remaining = running ? `max(0, clock_ms − (now − clock_anchor))` : `clock_ms`.
Starting the game or moving to a new period resets the clock to that period's
length, **stopped**. A period with 0 minutes has no clock (`clock_ms = NULL`).

## 6. Game JSON (REST + SSE)

```jsonc
{
  "id": "k3j9x2m4pq",
  "sport": "basketball",
  "sportName": "Basketball",
  "symbol": "basketball.fill",
  "status": "live",                       // scheduled | live | final | canceled
  "scheduledAt": 1793570400000,
  "location": "MCHS Gym",
  "home": { "name": "Marquette", "code": "MAR", "color": "#12214D", "score": 54, "setScore": null },
  "away": { "name": "Lincoln",   "code": "LIN", "color": "#B22234", "score": 50, "setScore": null },
  "period": 2,
  "periodLabel": "3rd Quarter",
  "periodShort": "Q3",
  "isOvertime": false,
  "line": [ { "home": 12, "away": 10 }, { "home": 20, "away": 18 }, { "home": 22, "away": 22 } ],
  "outs": null,                           // number for baseball, else null
  "note": "",
  "clock": { "running": true, "remainingMs": 312000, "anchorAt": 1793571000000, "periodMs": 480000 },  // or null
  "options": { "clockEnabled": true, "periodMinutes": 8, "overtimeMinutes": 4, "bestOf": null },
  "rules": { /* the SPORTS entry for this sport (incl. overtime.naming), with volleyball periods expanded for this game's bestOf */ },
  "scorekeeper": { "id": 3, "name": "Coach Smith" },   // null if unclaimed; only included for authenticated viewers, otherwise omitted
  "scoreboard": { "setting": "default", "custom": null, "address": "10.20.1.50:10001", "eligible": true, "manual": false,
                  "controlling": true, "state": "receiving", "message": "Score, clock and period come from the scoreboard.",
                  "lastReadingAt": 1793571000000 },   // §11; only for authenticated viewers
  "canStartAt": 1793563200000,            // scheduledAt − START_WINDOW_MINUTES
  "startedAt": 1793570460000, "endedAt": null,
  "updatedAt": 1793571000000,
  "version": 37,
  "channels": { "production": "dHN0LXNyY2gtY2hubA==", "sandbox": "…" }   // only while live; ids may be null if creation failed
}
```

`home.setScore` / `away.setScore` = current set points for `scoreMode: 'sets'`, else `null`.
Clients compute the running clock as
`remainingMs − (estimatedServerNow − anchorAt)` clamped at 0, where
`estimatedServerNow = Date.now() + (serverTime − receivedAt)` using the
`serverTime` field included in every API response and SSE `hello`/`game` event.

## 7. HTTP API

Base path `/api`. JSON in/out (`Content-Type: application/json`, body ≤ 64 KB).
Every successful response includes `"serverTime": <unix ms>`.
Errors: HTTP status + `{ "error": { "code": "snake_case", "message": "Human readable" }, "serverTime": … }`.
Codes used: `bad_request` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404,
`conflict` 409, `too_early` 409, `scoreboard_active` 409 (§11), `rate_limited` 429 (with a `Retry-After` header), `internal` 500.

### Authentication
* `POST /api/auth/login` `{ username, password, client: "web" | "ios" }`
  * `client: "web"` → sets cookie `mchs_session=<token>; HttpOnly; Secure (when request is https); SameSite=Lax; Path=/; Max-Age=2592000` and returns `{ user }`.
  * `client: "ios"` → returns `{ token, user }`; the app sends `Authorization: Bearer <token>`.
  * Sessions last 30 days, sliding (extended on use, at most once per hour).
  * Wrong username or password → 401 (an unknown username takes as long as a wrong
    password); right password for a disabled account → 403.
  * Throttling (429), counted per 15-minute window, attempts counted **before** the
    password is checked (so concurrent guesses can't slip past; a successful sign-in takes
    its attempt back):
    * per client address (§3; IPv6 per /64): 50 failed sign-ins;
    * per username + source: once a username has 10 failed sign-ins (from any address), it
      is locked **for every client address that has failed on it**; addresses without a
      failed attempt on it still get in, so guessing elsewhere can't lock the real user out.
  * At most 2 password verifications (scrypt) run at a time; more wait their turn.
* `POST /api/auth/logout` → deletes the session (and clears the cookie).
* `GET /api/auth/me` → `{ user }` or 401.
* `POST /api/auth/password` `{ currentPassword, newPassword }` (newPassword ≥ 8 chars) → `{ ok: true }`; other sessions of that user are revoked.
  A wrong `currentPassword` → 403; after 10 wrong ones in 15 min per user → 429 (a stolen
  session can't guess the password).
* `user` = `{ id, username, displayName, role }`.
* **CSRF**: when a request is authenticated by **cookie**, every non-GET request must carry header `X-MCHS-Client: web` (the portal's fetch wrapper always sends it) — otherwise 403. Bearer-token requests don't need it.
* Passwords: `crypto.scrypt` (N=16384, r=8, p=1, 64-byte key, 16-byte random salt), constant-time compare. Minimum 8 characters.

### Public (no auth)
* `GET /api/config` → `{ schoolName, homeTeam: { name, code, color }, startWindowMinutes, timeZone, apnsEnabled, version }`
* `GET /api/sports` → `{ sports: { <id>: <SPORTS entry + "id"> } }`
* `GET /api/games?scope=board|all[&before=<unix ms>]` → `{ games: [Game] }`
  * `board` (default): every `live` game, `scheduled` games with `scheduledAt` from 12 h ago to 14 days ahead, and `final`/`canceled` games that ended (or were scheduled) in the last 3 days. Sorted: live (by startedAt), then scheduled (scheduledAt asc), then final (endedAt desc).
  * `all` (auth required: any role, else 401): at most 500 games — the live ones first, then
    those scheduled nearest to now (before or after), so a season scheduled ahead never
    pushes tonight's game out — returned newest first (scheduledAt desc).
  * `all&before=<unix ms>` pages back to older games: the (up to) 500 games scheduled
    strictly before that time, scheduledAt desc. `before` with `board`, or not 1–15
    digits → 400.
* `GET /api/games/:id` → `{ game }` (404 if unknown)
* `GET /api/stream[?game=:id]` → `text/event-stream` (see §7.1)
* `GET /api/health` → `{ ok: true, version, uptimeSec, db: "ok", apns: { configured, environments: [..] }, sseClients }`
* `POST /api/devices` `{ token, environment, enabled, activitiesEnabled, appVersion }` → `{ ok: true }`
  * Upsert by `token` (hex, 32–512 chars, stored lowercase). `activitiesEnabled` (default
    `true`) and `appVersion` (≤ 32 chars) are optional. `previousToken` (optional) is deleted if present.
  * Re-registering clears `invalid_at` / `last_error` (APNs says a token it reported as
    gone may become valid again) — **except** a token marked invalid with `BadDeviceToken`
    that registers again for the **same** environment: a malformed token never becomes
    valid, so it stays out of every push-to-start fan-out.
  * Rate limit `DEVICE_RATE_LIMIT_PER_MINUTE` (default 600) per client address (§3), signed in or not.

### Scorekeeper (role `scorekeeper` or `admin`)
* `POST /api/games/:id/claim` `{ force?: boolean }` → `{ game }`. 409 `conflict` if another user holds it (admins may pass `force: true`) or the game is `final`/`canceled`.
* `POST /api/games/:id/release` → `{ game }` (holder or admin; not allowed while `live` unless admin).
* `POST /api/games/:id/start` → `{ game, push: { queued: <devices> } }`
  * Must be `scheduled`. Scorekeepers must hold the claim (an unclaimed game is auto-claimed) and `now ≥ canStartAt`, else 409 `too_early`. Admins may start any time.
  * Sets `status=live`, `startedAt=now`, `period=0`, `line=[{home:0,away:0}]`, `outs=0`, `note=''`, clock reset (stopped), then triggers the start push flow (§8) **asynchronously** (the HTTP response does not wait for APNs).
* `POST /api/games/:id/actions` `{ actionId, type, ... }` → `{ game, duplicate?: true }`
  * Caller must hold the claim (or be admin). Game must be `live` (except `set_score` by an admin on a `final` game — "correct final score": SSE `game` event, no push).
  * `actionId` (required, 8–64 printable ASCII chars): idempotency key. If an event with the same `(game_id, action_id)` exists, nothing is applied and the current game is returned with `duplicate: true`. Clients generate a UUID per user intent and reuse it on retries.
  * Types:
    * `score` `{ team: "home"|"away", points: int }` — `points` ∈ [−10, 10], ≠ 0; adds to the current period (409 if that period's total would exceed 9999). Points mode: a minus larger than the team's points in this period takes the rest off the earlier periods; 409 only if the team doesn't have that many points in all. Sets mode: a set's points can't go below 0 (409).
    * `set_score` `{ home: int, away: int, period?: int }` — absolute correction (0–9999 each). `period` (optional, 0 … current period, else 400) picks the period/set to correct; default the current one.
      Points mode: `home`/`away` are the **game totals**; the difference goes into that period. Without `period`, a decrease the current period can't absorb comes off the earlier periods; with an explicit `period`, 409 if that period would go below 0.
      Sets mode: sets that set's points (e.g. a mis-recorded earlier set).
      Admins may also send it for a `final` game to correct the final score.
    * `period` `{ delta: 1 | -1 }` — next/previous period (bounded by 0 and the sport's max, else 409). Moving forward appends `{home:0,away:0}` to `line` if needed; moving back drops trailing periods that have no points. Clock resets to the new period's length, stopped; `outs` reset to 0; `note` cleared.
    * `clock` `{ op: "start" | "stop" | "set", remainingMs?: number }` — 409 if the game has no clock this period.
      `start`: 409 if already running or at 0:00. `stop`: 409 if already stopped; an optional
      `remainingMs` (the time the scorekeeper saw — a stop can arrive late over weak gym Wi-Fi)
      is honored, clamped between what is left now and what was left when the clock was last
      started (or set). `set`: requires `0 ≤ remainingMs ≤ 3 600 000` and leaves the running
      state unchanged (re-anchors). Non-integral `remainingMs` is rounded.
    * `outs` `{ delta: 1 | -1 }` — baseball only (400 for other sports); see §5.
    * `note` `{ text: string }` — ≤ 40 chars after trim; `""` clears.
    * `undo` `{}` — reverts the most recent not-undone scoring event of this game (`score`, `set_score`, `period`, `clock`, `outs`, `note`) by restoring its `prev_state`; 409 if nothing to undo (or that period no longer exists after an options edit). Never reaches past a scoreboard update (§11): only events after the last one can be undone.
  * While the scoreboard drives the game (§11, `scoreboard.controlling`), `score`, `set_score`, `period`, `clock` and `undo` → 409 `scoreboard_active`. Notes stay manual.
  * Every applied action: `version+1`, `updated_at=now`, insert `game_events`, emit SSE `game`, schedule an APNs update when the Lock Screen content changed (§8.2).
* `POST /api/games/:id/end` → `{ game }` — holder or admin; `live` → `final` (409 otherwise), clock stopped, `note` cleared, `endedAt=now`, end push flow (§8).
* `POST /api/games/:id/scoreboard` `{ manual: boolean }` → `{ game }` — holder or admin, `scheduled` or `live`: score this game by hand (the scoreboard feed pauses for it) or let the scoreboard drive it again (§11).

### Admin (role `admin`)
* `POST /api/games` `{ sport, home:{name,code,color}, away:{name,code,color}, location, scheduledAt, options:{ clockEnabled?, periodMinutes?, overtimeMinutes?, bestOf? }, scoreboard? }` → `{ game }`
  * `scoreboard` (§11): `"default"` (the default), `"off"`, or the IP address of another scoreboard box, `"10.20.1.51"` or `"10.20.1.51:3001"` (IPv4/IPv6 literals only; port 10001 if omitted; 400 otherwise).
  * Validation: sport known; `home` optional (default: the `HOME_TEAM_*` team), `away` required; names 1–40 chars; codes 2–4 chars `[A-Z0-9]` (uppercased); colors `#RRGGBB`; `location` ≤ 100 chars; scheduledAt a number of ms (2000–2100); `periodMinutes` 1–60; `overtimeMinutes` 0–30; `bestOf` 3|5. Options that don't apply to the sport are validated but ignored. Missing options take the sport defaults.
* `PATCH /api/games/:id` same fields, all optional → `{ game }`. Sport and team names/codes/colors are locked once the game has **started** (also after it ended: Live Activities carry them) → 409. Changing the sport resets the options to its defaults. For a live game, options that would leave the current period beyond the last one allowed → 409; the clock is brought in line with the new options.
* `DELETE /api/games/:id` → `{ ok: true }` — not allowed while `live` (409; end or cancel it first, so its Live Activities get the end broadcast). Its channels are queued for deletion (§8.3).
* `POST /api/games/:id/cancel` → `{ game }` — `scheduled|live` → `canceled` (409 otherwise), clock stopped, `endedAt=now`; if it was live, run the end push flow with note `Canceled`.
* `GET /api/users` → `{ users: [user + { disabled, createdAt }] }`
* `POST /api/users` `{ username, displayName, password, role }` → `{ user }` (409 if username taken)
* `PATCH /api/users/:id` `{ displayName?, role?, disabled?, password? }` → `{ user }` — setting a password or disabling revokes that user's sessions. An admin can't demote/disable/delete themself, and the last enabled admin can't be removed (409).
* `DELETE /api/users/:id` → `{ ok: true }`
* `GET /api/admin/status` → `{ apns: { configured, environments, teamId, keyId, bundleId, error? }, devices: { production: { enabled, total, invalid }, sandbox: {…} }, recentPushes: [push_log rows, newest 50], sseClients }` (`error` only while APNs isn't configured)
* `POST /api/admin/apns-check` → `{ results: { <env>: { ok, channelId?, error? } } }` — creates a test broadcast channel in each environment, reads it back, then deletes it. Verifies the key, team, bundle and broadcast capability end to end.
* `GET /api/admin/scoreboard` → `{ defaultAddress: "<ip>:<port>" | null, feeds: [{ address, gameId, state, error, lastReadingAt }] }` (§11)
* `PATCH /api/admin/scoreboard` `{ defaultAddress: "<ip>[:port]" | null | "" }` → same (400 on an invalid address; `null`/`""` clears it)
* `POST /api/admin/scoreboard/test` `{ address }` → `{ result: { address, inUse, gameId?, connected, receiving, error, bytes, frames, badFrames, reading: { clockMs, clockRunning, home, away, period, sportCode, games? } } }` — listens to that scoreboard for a few seconds (up to ~10 s). If a live game is already reading it, describes that connection instead (`inUse: true`); the box accepts one connection at a time.

### 7.1 Server-Sent Events — `GET /api/stream`
Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`,
`X-Accel-Buffering: no`. Every event's `data` is **one line** of JSON. Besides the
escapes `JSON.stringify` makes, the characters U+0085, U+2028 and U+2029 are written
as `\u0085`, `\u2028`, `\u2029` (still valid JSON): some line readers, including the
iOS app's `AsyncLineSequence`, split lines on them.
```
retry: 3000

event: hello
data: {"serverTime":1793571000000}

event: game
data: {"serverTime":1793571001234,"game":{…Game…}}

event: removed
data: {"serverTime":…,"id":"k3j9x2m4pq"}

: ping
```
* `game` is sent whenever any game changes (create/edit/claim/start/action/end/cancel).
  With `?game=:id` only that game's events are sent (404 before streaming if the game doesn't exist).
* A stream opened with a valid session (cookie or bearer) gets the signed-in Game JSON
  (with `scorekeeper`); everyone else gets the public one. The session is re-checked at
  every ping: once it is signed out, expired or revoked (password reset, account disabled),
  the stream carries on with the public JSON.
* A `: ping` comment every 25 s keeps proxies from closing the connection.
* Limits: `SSE_MAX_PER_IP` (default 2000) concurrent streams per client address,
  `SSE_MAX_CONNECTIONS` (default 20000) in total (§3; → 429 before streaming starts).
  A client that stops reading (over 1 MB buffered) is disconnected.
* **iOS parsing note:** `URLSession.AsyncBytes.lines` drops empty lines, so the
  app must dispatch on each `data:` line using the most recent `event:` name
  (reset after dispatch) rather than waiting for the blank-line terminator.

## 8. Live Activity push flows (APNs)

APNs specifics (hosts, ports, headers, payload keys) are in §8.4 and are the
verified values the server must use.

### 8.1 Start (scorekeeper taps **Start game**)
1. For each environment in `APNS_ENVIRONMENTS`: create a broadcast channel for the game
   if `channel_<env>` is NULL (message storage policy `APNS_CHANNEL_STORAGE_POLICY`,
   default **0**) and store its id.
2. For every device with `enabled=1 AND activities_enabled=1 AND invalid_at IS NULL` in
   that environment (Sports Updates on **and** Live Activities allowed), send a
   **push-to-start** with `input-push-channel` = that environment's channel id,
   the `GameActivityAttributes`, the initial content state, `stale-date` (§8.2) and an alert
   (`title`: "MAR vs LIN is live", `body`: "Basketball · Follow the score on your Lock Screen").
   * Fan-out over a single HTTP/2 session per environment, ≤ 100 requests in flight.
   * The fan-out covers the devices registered when the game started, in device-id order,
     and its progress is persisted (`push_progress`): devices are claimed in blocks of 100
     and the cursor is saved before any of them is sent (on a clean shutdown, right after
     the last device handed out). After a restart the scheduler resumes an unfinished
     fan-out where it stopped, as long as the game is still live. No device gets a second
     start (a crash may skip at most the block whose pushes were being sent).
   * Every 50 devices the game is re-read: later devices get the latest state, and the
     fan-out stops if the game is no longer live (end/cancel also stop it at once). It stops at the
     first setup error (§8.4) instead of failing for every device.
   * `429`, `5xx` or a request that never reached APNs → one retry after 1 s.
   * `410` or `400 BadDeviceToken`/`DeviceTokenNotForTopic` → mark the device `invalid_at=now, last_error=<reason>`.
   * Write one `push_log` row per environment with sent/failed counts.
3. If channel creation fails for an environment, the start flow retries it after 1, 3, 10
   and 30 s while the game is live. If there is still no channel it logs
   `skipped: no broadcast channel` and leaves the fan-out pending: the scheduler (every
   minute) and the next update retry the channel, and the fan-out runs as soon as it exists.

### 8.2 Update (any applied action while live)
* Only changes of a live game that alter what the Lock Screen shows (score, period,
  status, outs, clock, note) are broadcast; corrections of a `final` game are not.
* Coalesce per game: at most one broadcast per game per update interval
  (`APNS_MIN_UPDATE_INTERVAL_MS`, default **5 s**, adaptive — see §8.4), leading +
  trailing, so the first change goes out immediately and the latest state always gets sent.
* For each environment: send one **broadcast** with `event: "update"`, the content state,
  `stale-date`, priority per §8.4. An environment without a channel gets one created first
  (and a pending push-to-start fan-out there runs once it exists).
* After a restart the scheduler's first run (5 s after start, then every minute) sends one
  fresh update for every live game, since the last change before the restart may never
  have gone out.
* `stale-date` (start and update) = now + 30 min, or — while the game clock runs — the
  later of that and the moment the clock reaches 0:00 + 10 min (a running clock sends
  no pushes, so the activity must not turn stale mid-period).
* The clock ticks on the device by itself (`clockEndsAt`), so a running clock costs no
  pushes — only start/stop/set do.

### 8.3 End (End game, cancel, or auto-final)
* Broadcast `event: "end"` with the final content state (note cleared on end; `Canceled`
  for a canceled game) and `dismissal-date` = now + 2 h. The end broadcast is persisted
  (`pending_ends`) before it is sent and retried — also after a restart — until it is
  delivered, fails permanently, or 8 h have passed (iOS has ended the activity by then).
  Retries: after 1, 3 and 10 s (a `429` waits at least the game's backed-off update
  interval), then every minute from the scheduler; transient failures (`429`, `5xx`,
  network) and setup errors are retried, anything else drops it.
* A push-to-start fan-out still running is stopped first; the end goes out once its
  last requests are back, plus 5 s for those devices to join the channel.
* Channel cleanup goes through a persisted queue (`channel_cleanup`): when a game ends (or
  is deleted) its channels are queued with `delete_after` = `ended_at` (or now) + 6 h; a
  channel created after its game already ended is queued for immediate deletion. The
  scheduler deletes due channels at Apple — `ChannelNotRegistered` / `BadChannelId` count
  as deleted, other failures are retried 10 min later — then clears `channel_<env>`; a
  channel whose end broadcast is still pending is never deleted. Each scheduler run also
  queues any ended game's channel that is missing from the queue, so none is leaked.

### 8.4 APNs protocol details (verified — full notes and sources in RESEARCH.md)

| Request | Host (sandbox / production) | Method + path | Key headers |
| --- | --- | --- | --- |
| Push-to-start | `api.sandbox.push.apple.com:443` / `api.push.apple.com:443` | `POST /3/device/<hex token>` | `apns-push-type: liveactivity`, `apns-topic: <bundle>.push-type.liveactivity`, `apns-priority: 10`, `apns-expiration: <now+300>` |
| Broadcast update/end | same hosts as above | `POST /4/broadcasts/apps/<bundle>` | `apns-channel-id`, `apns-push-type: liveactivity`, `apns-priority: 10\|5`, `apns-expiration: 0` (no `apns-topic`) |
| Create channel | `api-manage-broadcast.sandbox.push.apple.com:2195` / `api-manage-broadcast.push.apple.com:2196` | `POST /1/apps/<bundle>/channels` body `{"message-storage-policy":0,"push-type":"LiveActivity"}` → `201`, id in response header `apns-channel-id` | — |
| Read channel (apns-check) | management hosts | `GET /1/apps/<bundle>/channels` → `200` | request header `apns-channel-id` |
| Delete channel | management hosts | `DELETE /1/apps/<bundle>/channels` → `204` | request header `apns-channel-id` |
| List channels | management hosts | `GET /1/apps/<bundle>/all-channels` → `{"channels":[…]}` | — |

* All requests carry `authorization: bearer <JWT>` (ES256 / P1363, `kid`=key id,
  `iss`=team id, `iat`; cached and re-minted every 50 min; a `403 ExpiredProviderToken`
  re-mints it — if at least 20 min old — and retries once) and a random `apns-request-id`.
* One long-lived HTTP/2 session per host (≤ 4 hosts), PING after 10 min idle (10 s
  timeout), dropped and lazily reconnected (backoff 0.5 s doubling to 30 s) on
  `goaway`/`error`/`close`/`frameError`/failed ping; 15 s per-request timeout; one retry on
  `ERR_HTTP2_GOAWAY_SESSION`, `ERR_HTTP2_INVALID_SESSION`, `ERR_HTTP2_STREAM_CANCEL`,
  `NGHTTP2_REFUSED_STREAM`, `ECONNRESET`. Payloads over 4096 bytes (device) / 5120 bytes
  (broadcast) are refused before sending.
* Channel storage policy **0** (No Message Stored — Apple's recommendation for sports
  scores, higher publish budget) ⇒ broadcasts must send `apns-expiration: 0`. Devices that
  are offline at the moment of an update catch up on the next one; the app also ends
  finished games' activities when opened, the widget dims stale activities, and iOS ends
  every activity after 8 h. (Policy is configurable: `APNS_CHANNEL_STORAGE_POLICY=1` keeps
  the latest message for offline devices but has a lower budget; with policy 1 send
  `apns-expiration` = now + 8 h instead of 0.)
* `aps.timestamp` (unix seconds, integer) must strictly increase per game and
  environment: use `max(nowSec, lastSentSec + 1)`. The last one sent is persisted
  (`push_progress.last_timestamp`), so this holds across restarts too.
* Broadcast `apns-priority`: **10** when the coalesced change touches score, period,
  status, outs or the clock; **5** for note-only changes.
* Throttling: a transient failure of a broadcast update (`429 TooManyRequests`, `5xx`,
  network) is retried and doubles that game's update interval (cap 60 s); each successful
  send shrinks it by 1 s back toward the base (`APNS_MIN_UPDATE_INTERVAL_MS`, default
  5000). The latest state is always sent eventually.
* Setup errors (`FeatureNotEnabled`, `TopicDisallowed`, `BadTopic`, `MissingTopic`,
  `BadEnvironmentKeyIdInToken`, `InvalidProviderToken`, `MissingProviderToken`,
  `ExpiredProviderToken`, `TooManyProviderTokenUpdates`, `BadCertificate`,
  `BadCertificateEnvironment`, `Forbidden`) and `ChannelNotRegistered` / `BadChannelId`
  are logged as errors with a fix hint and recorded in `push_log` (see README
  troubleshooting). `ChannelNotRegistered` / `BadChannelId` on an update → clear that
  channel id and recreate it on the next update.

### 8.5 Live Activity payload shape (must match the Swift types exactly)

`attributes-type`: `"GameActivityAttributes"`

`attributes` (fixed for the life of the activity):
```json
{ "gameId": "k3j9x2m4pq", "sport": "basketball", "sportName": "Basketball", "symbol": "basketball.fill",
  "homeName": "Marquette", "homeCode": "MAR", "homeColor": "#12214D",
  "awayName": "Lincoln",   "awayCode": "LIN", "awayColor": "#B22234" }
```

`content-state`:
```jsonc
{
  "status": "live",            // scheduled | live | final | canceled
  "homeScore": 54, "awayScore": 50,   // total points, or sets won (volleyball)
  "homeSetScore": null, "awaySetScore": null,   // volleyball: current set points (omit or null otherwise)
  "periodLabel": "3rd Quarter", "periodShort": "Q3",
  "note": "",
  "clockRemaining": 312.0,     // seconds remaining at updatedAt; null/omitted = no clock
  "clockEndsAt": 1793571312.0, // unix SECONDS when a RUNNING clock reaches 0:00; null/omitted when stopped
  "outs": null,                // baseball 0–2, else null/omitted
  "updatedAt": 1793571000.0    // unix seconds
}
```
* Times are **plain Unix seconds as JSON numbers** and the Swift properties are
  `Double`, never `Date` (ActivityKit's decoder would treat a `Date` as seconds
  since 2001).
* `status` is a `String` on the Swift side (not an enum) so an unknown value can
  never make an update undecodable.
* Required (non-optional in Swift, always sent): `status`, `homeScore`, `awayScore`,
  `periodLabel`, `periodShort`, `updatedAt`. **Every other field is an Optional in
  Swift** (a missing key for a non-optional property fails the whole push, even with a
  default value). Future fields must be added as Optionals.
* Combined size of `attributes` + `content-state` must stay well under 4 KB (team
  names ≤ 40 chars keep it ~600 bytes).

## 9. iOS app

* `LiveScoresConfig.serverURL` — the server's base URL, from the one constant
  `LiveScoresConfig.defaultServerURL` (set it to the portal's `https://` address; while it
  is the `example.com` placeholder the app shows live scores as not set up). In DEBUG it
  can be overridden with the `LiveScoresServerURL` user default / launch argument
  `-LiveScoresServerURL http://localhost:8080`.
* **Device registration** — on launch and whenever the push-to-start token,
  the Sports Updates toggle or `areActivitiesEnabled` changes, the app `POST`s
  `/api/devices`. Environment: `sandbox` for DEBUG builds, `production` otherwise.
  Observation of `pushToStartTokenUpdates` and `activityUpdates` starts in
  `didFinishLaunching` (push-to-start relaunches the app in the background), and the
  static `pushToStartToken` is re-read a few seconds later (Apple's workaround for a
  token-delivery timing bug before iOS 26).
* **Scores screen** (everyone, side menu + Home tile): Live / Upcoming / Final,
  updated over SSE while visible. Game detail shows the full scoreboard + line
  score and **Show on Lock Screen** (`Activity.request(..., pushType: .channel(id))`
  using the channel for the app's environment) / **Remove from Lock Screen**.
  When the game has no channel (APNs not configured), start with `pushType: nil`
  and update it locally from SSE while the app is open.
* **Scorekeeper** (toolbar button on the Scores screen): sign in with a
  live-scores account (separate from the Firebase app account; token in Keychain),
  list/claim games, start, score, end. Same capabilities as the web console.
* **Live Activity UI** (widget extension): team codes & colors, big scores,
  period, live-ticking clock (`Text(timerInterval:countsDown:)` when
  `clockEndsAt` is set), note, volleyball sets, baseball outs, LIVE/FINAL state,
  stale state; compact/minimal/expanded Dynamic Island.
* On launch / foreground the app ends any of its Live Activities whose game is
  final, canceled or deleted on the server.

## 10. Security notes

* Node binds to loopback only; Caddy is the only public listener (none with a
  Cloudflare Tunnel, whose connector only connects out).
* No secrets in the web portal or the iOS app. The `.p8` key lives in
  `/etc/mchs-live/` (mode 0640, group `mchslive`).
* Session tokens: 32 random bytes, base64url; only their SHA-256 is stored.
* Cookie sessions require the `X-MCHS-Client: web` header on writes (CSRF).
* Every input is validated server-side; the client checks are for UX only.
* Response headers: `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`,
  and on HTTPS requests `Strict-Transport-Security: max-age=31536000` (Caddy sets the same).
  When `PUBLIC_URL` is https and a trusted proxy reports `X-Forwarded-Proto: http`
  (a Cloudflare zone without "Always Use HTTPS"), GET/HEAD get a 308 to the same path on
  `PUBLIC_URL`'s origin and other methods a 403, so no password travels over plain HTTP.
* Rate limits: `RATE_LIMIT_PER_MINUTE` (default 3000) requests per client address per
  minute on `/api/*` for requests without a valid session (any request carrying a valid
  session cookie or bearer token is exempt), plus the endpoint limits above (§3) and the
  sign-in / password-change throttling (§7 Authentication).
* Admin CLI (`server/cli.js`; `sudo mchs-live-cli` in production): `create-user`,
  `reset-password`, `list-users`, `delete-user`, `apns-check`. Scripts write options as
  `--opt=value` (`node:util` `parseArgs` rejects a separate value that starts with `-`)
  and hand passwords over with `--password-stdin` (the first line of stdin), never in
  argv, which every local user can read in `ps` / `/proc`. Without either, the CLI
  prompts on a terminal or generates and prints a password.

## 11. Daktronics scoreboard feed

The gym's Daktronics **All Sport 5000** console sends its "Enhanced RTD" (real-time data)
out of its serial port; a **Lantronix** serial-to-Ethernet box (UDS1100, factory TCP port
10001, serial 19200 8N1) puts it on the network. The server is a read-only TCP client of that
box (`server/rtd.js` parses the stream, `server/scoreboard.js` runs the connections).

**Which games.** An admin stores a default box address (`settings` row
`scoreboard.defaultAddress`); each game has `scoreboard` = `default` | `off` | its own
address. The feed drives a game only while it is **live**, its sport is **basketball or
volleyball**, and its **home team is the school's team** (name or code equal to
`HOME_TEAM_NAME` / `HOME_TEAM_CODE`). Of several live games on one box, the one **started
last** wins (an earlier game someone forgot to end must not take the new game's scores); the
others show `standby` and are switched to scoring by hand for good (`scoreboard_mode` event
without a user, reason "a newer game took the scoreboard"), so they don't get the box - and the
newer game's scores - back when it ends; only a scorekeeper's **Use the scoreboard** does that.
If the winner is scored by hand, nobody gets the feed. A person still starts and ends every
game.

**What is read.** Only the score, the main clock and the period:

| Field (1-based position, length) | Basketball | Volleyball |
| --- | --- | --- |
| 1, 5 — main clock `mm:ss` / `ss.t` (6, 8 `mm:ss.t` as a fallback) | game clock | (ignored: no clock in the app) |
| 28, 1 — `s` = clock stopped, space = running | clock state | — |
| 108, 4 / 112, 4 — home / guest score | game totals | points in the current game |
| 142, 2 — period / game number | period (5 = 1st overtime …) | game (set) number |
| 222 + 2(N−1), 2 / 242 + 2(N−1), 2 — home / guest score of game N | — | finished games' scores |

Frames: `SYN "00000000" SOH header [STX data] EOT checksum ETB`; the header `004210NNNN` gives
the data's 0-based position in the block (positions shifted by the console's RTD OFFSET
setting are taken modulo 5000); the checksum is the sum of the bytes after SYN through EOT,
mod 256, as two uppercase hex digits; frames with a bad checksum or another header are
ignored. The console sends the clock every second and other fields only when they change (the
whole block when the clock stops), so after (re)connecting a field is **unknown until a frame
covers it** — an unknown score is never applied as 0. Sources: Daktronics ED-12483 and the
AS5-Basketball / AS5-Volleyball data definitions; checked against captured streams and
independent parsers.

**Applying a reading** (`GameService.applyScoreboard`, one transaction, only when something
changed): the period first (stepping like `period` actions: the clock resets, the note
clears; periods past the game's last allowed one are ignored), then the score (points mode:
the totals, the difference going into the current period like `set_score`; sets mode: the
current game's points, and each finished game's score as the console recorded it unless it
reads 0-0), then the clock — but only for a game with a clock in that period: it is set when
it starts, stops or is set, or when a running clock is more than 1.5 s off (clients
interpolate between updates, as with manual scoring). Each change is a `game_events` row of
type `scoreboard` (no `prev_state`, not undoable; `undo` never goes past one) followed by the
usual SSE event and APNs update; a reading that changes nothing writes nothing. Points
mode reaches every total the console shows (a decrease comes off the current period, then
earlier ones, then later ones left by a period stepped back). Frames arriving together are
applied together (150 ms debounce, 500 ms at most).

Guards against the console moving on before the app does:
* **Console reset**: the console back at period/game 1 with lower scores (volleyball: game 1
  at 0-0) while the game is further on means it was set up for the next game before this one
  was ended. Nothing of it is applied; after 30 s the game is switched to scoring by hand
  (reason "the scoreboard was reset for another game") with its score intact, for the
  scorekeeper to end. If the scorekeeper then chooses **Use the scoreboard**, the check is
  off for that game.
* **Volleyball clear**: points cleared to 0-0 in the same game take the console's record of
  that game when it has one; otherwise they are held for 20 s (for good on the match's last
  set), so a finished set keeps its score when the operator clears the board before moving on.
* **Volleyball beyond the match**: a game number past the match's last set is ignored, and so
  are its points.

**Screens.** Admin console → System: the default address, **Test connection** (what the
box sends right now) and the live feeds; the game form: Use the default / Another scoreboard
/ Off (basketball and volleyball only). Scorekeeper console (portal and iOS app): a
"Scoreboard" panel with `scoreboard.message`, warning style for `unreachable` / `waiting`,
and **Score by hand** / **Use the scoreboard** (before the start too). Queued actions the
server refuses with `scoreboard_active` are dropped and reported; later notes still go
through.

**Scorekeepers.** While `scoreboard.controlling` is true the server rejects `score`,
`set_score`, `period`, `clock` and `undo` (409 `scoreboard_active`); the portal and the app
lock those controls and show `scoreboard.message`. `POST /api/games/:id/scoreboard
{ manual: true }` (holder or admin) switches the game to scoring by hand; `{ manual: false }`
hands it back. `controlling` stays true while the box is unreachable — switching to by-hand
scoring is deliberate.

**Status updates.** A change of feed status (connected, unreachable, ...) gets a new game
`version` (not `updated_at`) and an SSE event, like any change. Whenever a change affects which
game a box drives (status, `scoreboard`, the manual switch, sport, home team, start), the
feed is re-decided before the change is published, so the response, the SSE event and the
next action's 409 check agree. Changing the default address republishes every scheduled or
live game on the default.

**Connections.** Opened only while a game needs the feed, closed after; never written to
(the Lantronix would pass the bytes into the console). TCP keepalive; reconnect after 2, 5,
10, 20 then every 30 s (the backoff resets only once the box sends valid frames); reconnect
after 90 s without data; `waiting` after 15 s without data. The reader drops garbage in linear
time. Addresses are IPv4/IPv6 literals in one canonical form (IPv4-mapped IPv6 as IPv4, no
zone ids, at most 64 characters).
A reconnect, or another game taking over the box, starts from an empty block. The box accepts
**one TCP connection at a time**: if another system (e.g. a Daktronics video system) holds it,
the server is refused (`unreachable`, "connection refused"). `POST /api/admin/scoreboard/test`
reuses the live connection when there is one.
