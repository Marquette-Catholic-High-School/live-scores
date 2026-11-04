# MCHS Live Scores — Architecture & API Contract

This document is the single source of truth for the live-score system. The server
(`server/`), the web portal (`public/`) and the deploy scripts (`deploy/`) - the
`web-portal` folder of the app project, published as
[live-scores](https://github.com/Marquette-Catholic-High-School/live-scores) - and the
iOS app (`MCHS/`, `MCHSWidget/` in the app project) are all built against it. If code and this document disagree, fix one of them — don't let
them drift.

## 1. What it does

1. An **admin** schedules games (sport, boys/girls and level, teams, time, location)
   in the web portal.
2. A **scorekeeper** signs in (web portal or the iOS app), claims a game, and at
   game time taps **Start game**. A home basketball or volleyball game on the gym's
   scoreboard (§11) starts by itself at its time, as soon as the scoreboard is on.
3. The server immediately **starts a Live Activity on every iPhone with the app**
   (APNs push-to-start; opt-out: the app's "Live Activities" setting, on by default),
   each one subscribed to an APNs **broadcast channel** for that game.
4. Every score / period / clock change the scorekeeper makes is sent as **one
   broadcast push** to that channel, so every Lock Screen and Dynamic Island
   updates within a second or two, no matter how many fans there are.
5. The web portal's public scoreboard and the app's Scores screen update live via
   **Server-Sent Events**.
6. **End game** pushes the final score and the Live Activity dismisses itself
   two hours later. A game the scoreboard drives ends by itself two minutes after the
   final horn (§11). Live games nobody has changed for `AUTO_FINAL_HOURS` are ended automatically.

Firebase is **not** used by any part of this system. The rest of the iOS app
(accounts, photographer scheduler, Photo Drop, FCM announcements) stays on
Firebase and is untouched; the only touch point is the notification settings screen,
where the app's own "Live Activities" switch (on by default, separate from the "Sports
Updates" notifications) opts the device out of game Live Activities.

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
  scoreboard through its Lantronix serial-to-Ethernet box (read-only: a TCP client of the box,
  or listening for the UDP datagrams it sends) and keeps the game's score, clock and period
  in step.
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
  scoreboard TEXT NOT NULL DEFAULT 'default',   -- schema 3, §11: 'default' | 'off' | '<ip>:<port>' | 'udp://<ipv4>:<port>'
  scoreboard_manual INTEGER NOT NULL DEFAULT 0, -- schema 3, §11: 1 = the scorekeeper scores this game by hand
  gender TEXT,                       -- schema 4, §6: 'boys' | 'girls' | NULL (not set)
  level TEXT                         -- schema 4, §6: 'varsity' | 'jv' | 'freshman' | NULL (not set)
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
  enabled INTEGER NOT NULL DEFAULT 1,-- the app's "Live Activities" setting on (opt-out)
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

The schema version is `PRAGMA user_version` (currently **4**). Migrations run at startup,
each in one transaction; migration 2 also queues the channels of games that had already
ended for deletion; migration 4 adds `gender` and `level` (NULL for existing games). A database with a newer version than the server knows is refused
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
  "gender": "girls",                      // boys | girls | null (not set)
  "level": "jv",                          // varsity | jv | freshman | null (not set)
  "sportName": "Girls JV Basketball",     // the game's display label (below)
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

`sportName` is the game's full display label, `[Boys|Girls] [Varsity|JV|Freshman] <sport
name>`: "Girls JV Basketball", "Boys Varsity Volleyball", "Girls Basketball" (no level),
"Freshman Basketball" (no gender), "Basketball" (neither). Every client shows it as the
game's title (so builds from before the label show it with no change; it can be about 30
characters, so titles must fit or wrap); the plain sport name stays in `GET /api/sports`.
The server builds it with `gameLabel(game)` (`server/games.js`), for the JSON, the Live
Activity attributes (§8.5) and the push-to-start alert.

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
  * The scoreboard feed starts eligible games by itself the same way, with no user (§11 "Starting by itself"); a start request for a game already started → 409.
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
* `POST /api/games/:id/scoreboard` `{ manual: boolean }` → `{ game }` — holder or admin, `scheduled` or `live`: score this game by hand (the scoreboard feed pauses for it; before the start it also keeps the game from starting by itself, and live it keeps it from ending at the final horn) or let the scoreboard drive it again (§11).

### Admin (role `admin`)
* `POST /api/games` `{ sport, gender?, level?, home:{name,code,color}, away:{name,code,color}, location, scheduledAt, options:{ clockEnabled?, periodMinutes?, overtimeMinutes?, bestOf? }, scoreboard? }` → `{ game }`
  * `gender`: `"boys"`, `"girls"` or `null`; `level`: `"varsity"`, `"jv"`, `"freshman"` or `null` (exact lowercase values; omitted or `null` = not set; anything else → 400 `gender must be "boys", "girls" or null.` / `level must be "varsity", "jv", "freshman" or null.`). They make the game's label (§6).
  * `scoreboard` (§11): `"default"` (the default), `"off"`, or the address of another scoreboard box (§11 "Addresses"): over TCP `"10.20.1.51"`, `"10.20.1.51:3001"` or `"tcp://10.20.1.51"` (IPv4/IPv6 literals only; port 10001 if omitted; the Lantronix box's own ports → 400), over UDP `"udp://10.20.1.51"` or `"udp://10.20.1.51:21001"` (IPv4 only; port 21000 if omitted, 1024–65535). Stored and returned in canonical form; 400 otherwise.
  * Validation: sport known; `home` optional (default: the `HOME_TEAM_*` team), `away` required; names 1–40 chars; codes 2–4 chars `[A-Z0-9]` (uppercased); colors `#RRGGBB`; `location` ≤ 100 chars; scheduledAt a number of ms (2000–2100); `periodMinutes` 1–60; `overtimeMinutes` 0–30; `bestOf` 3|5. Options that don't apply to the sport are validated but ignored. Missing options take the sport defaults.
* `PATCH /api/games/:id` same fields, all optional (`null` clears `gender` / `level`) → `{ game }`. `gender` and `level` can be changed in any status; Live Activities already showing keep the label they started with (attributes are fixed, §8.5), new ones get the new label. Sport and team names/codes/colors are locked once the game has **started** (also after it ended: Live Activities carry them) → 409. Changing the sport resets the options to its defaults. For a live game, options that would leave the current period beyond the last one allowed → 409; the clock is brought in line with the new options.
* `DELETE /api/games/:id` → `{ ok: true }` — not allowed while `live` (409; end or cancel it first, so its Live Activities get the end broadcast). Its channels are queued for deletion (§8.3).
* `POST /api/games/:id/cancel` → `{ game }` — `scheduled|live` → `canceled` (409 otherwise), clock stopped, `endedAt=now`; if it was live, run the end push flow with note `Canceled`.
* `GET /api/users` → `{ users: [user + { disabled, createdAt }] }`
* `POST /api/users` `{ username, displayName, password, role }` → `{ user }` (409 if username taken)
* `PATCH /api/users/:id` `{ displayName?, role?, disabled?, password? }` → `{ user }` — setting a password or disabling revokes that user's sessions. An admin can't demote/disable/delete themself, and the last enabled admin can't be removed (409).
* `DELETE /api/users/:id` → `{ ok: true }`
* `GET /api/admin/status` → `{ apns: { configured, environments, teamId, keyId, bundleId, error? }, devices: { production: { enabled, total, invalid }, sandbox: {…} }, recentPushes: [push_log rows, newest 50], sseClients }` (`error` only while APNs isn't configured)
* `POST /api/admin/apns-check` → `{ results: { <env>: { ok, channelId?, error? } } }` — creates a test broadcast channel in each environment, reads it back, then deletes it. Verifies the key, team, bundle and broadcast capability end to end.
* `GET /api/admin/scoreboard` → `{ defaultAddress: "<ip>:<port>" | "udp://<ipv4>:<port>" | null, feeds: [{ address, gameId, watching, state, error, lastReadingAt }] }` (§11) — one feed per scoreboard a live game reads (`watching: false`), and one per scoreboard watched for a scheduled game to start (`watching: true`, `gameId` = that game)
* `PATCH /api/admin/scoreboard` `{ defaultAddress: "[tcp://]<ip>[:port]" | "udp://<ipv4>[:port]" | null | "" }` → same (400 on an invalid address, with the reason; `null`/`""` clears it)
* `POST /api/admin/scoreboard/test` `{ address }` (same forms) → `{ result }` — listens to that scoreboard for a few seconds (up to ~10 s) and reports what arrived (§11 "Test connection"):
  `{ address, transport: "tcp" | "udp", inUse, gameId?, watching?, connected, receiving, error, bytes, frames, badFrames, reading: { clockMs, clockRunning, home, away, period, sportCode, games? }, listenedMs }`,
  plus `closedByBox` over TCP and `datagrams`, `otherSources: [{ address, datagrams }]`, `firewallHint` over UDP.
  If a feed already reads that address, describes that feed instead (`inUse: true`, `gameId`, `watching`: false for a live
  game's feed, true for one watching for a scheduled game to start, whose id is then `gameId`): the box accepts one
  TCP connection at a time; over UDP the test shares the port's socket with any feed on it.

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

### 8.1 Start (scorekeeper taps **Start game**, or the scoreboard starts the game, §11)
1. For each environment in `APNS_ENVIRONMENTS`: create a broadcast channel for the game
   if `channel_<env>` is NULL (message storage policy `APNS_CHANNEL_STORAGE_POLICY`,
   default **0**) and store its id.
2. For every device with `enabled=1 AND activities_enabled=1 AND invalid_at IS NULL` in
   that environment (the app's Live Activities setting on **and** Live Activities allowed in
   iOS), send a **push-to-start** with `input-push-channel` = that environment's channel id,
   the `GameActivityAttributes`, the initial content state, `stale-date` (§8.2) and an alert
   (`title`: "MAR vs LIN is live", `body`: "<label> · Follow the score on your Lock Screen",
   e.g. "Girls JV Basketball · Follow the score on your Lock Screen"; label per §6).
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

### 8.3 End (End game, cancel, auto-final, or the final horn §11)
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
{ "gameId": "k3j9x2m4pq", "sport": "basketball", "sportName": "Girls JV Basketball", "symbol": "basketball.fill",
  "homeName": "Marquette", "homeCode": "MAR", "homeColor": "#12214D",
  "awayName": "Lincoln",   "awayCode": "LIN", "awayColor": "#B22234" }
```
`sportName` is the game's label (§6), up to about 30 characters ("Girls Varsity Basketball",
"Boys Freshman Volleyball"); the widget must fit it. Attributes never change once an
activity runs: editing a live game's gender or level updates the game JSON and the
activities started after the edit (a push-to-start fan-out still running picks it up for
the devices it hasn't reached), not the ones already on Lock Screens.

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
  the app's **Live Activities** setting (on by default, a missing setting means on; it
  alone sets `enabled`, while "Sports Updates" controls only the sports notifications) or
  `areActivitiesEnabled` changes, the app `POST`s `/api/devices`. Environment: `sandbox` for DEBUG builds, `production` otherwise.
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
10001, serial 19200 8N1) puts it on the network. The server reads it, never writes to it,
either as a TCP client of the box or by listening for the UDP datagrams the box sends
(`server/rtd.js` parses the stream, `server/scoreboard.js` runs the feeds,
`server/scoreboard-udp.js` the UDP sockets).

**Addresses.** The setting names the transport. Stored values are the canonical form, so
one box gets one feed; values stored before UDP existed are all TCP and keep working.
* **TCP** (the box is a TCP server on its Channel 1 "Local Port"): `10.20.1.50`,
  `10.20.1.50:10001`, `fe80::5`, `[fe80::5]:10001`, each optionally with `tcp://` (scheme
  case-insensitive) → `10.20.1.50:10001` / `[fe80::5]:10001`. Port 10001 if omitted.
* **UDP** (the box sends datagrams; Daktronics usually sets Connect Mode CC, Datagram Type
  01, often to the subnet broadcast address and UDP port 21000 so its own Data Monitor and
  other PCs all receive them): `udp://10.20.1.50` or `udp://10.20.1.50:21000` →
  `udp://10.20.1.50:21000`, meaning: listen on UDP port 21000 on every IPv4 interface of the
  server and use only datagrams whose source IP is 10.20.1.50. Port 21000 if omitted. IPv4
  only (an IPv4-mapped IPv6 literal becomes IPv4; any other IPv6 → 400 "A scoreboard that
  sends over UDP needs an IPv4 address."). The port is the server's: 1024–65535 (the service
  runs unprivileged, without `CAP_NET_BIND_SERVICE`).
* **The Lantronix box's own ports** are refused for TCP with a 400 that says what the port is
  and what to use instead ("Port 30718 is the Lantronix box's setup port and never sends
  scoreboard data. Use the box's data port (Channel 1 "Local Port", 10001 unless it was
  changed), or udp://<ip>:<port> if the box sends over UDP."): 30718 (77FEh, setup/discovery:
  it accepts a TCP connection but only answers binary configuration requests), 30704 (GPIO),
  9999 (Telnet setup), 14000–14009 (Com Port Redirector), 80 (web page). Not for UDP, where
  the port is on the server.
* IP literals only (the box has no DNS name), trimmed, at most 70 characters, no IPv6 zone
  ids, IPv4-mapped IPv6 as IPv4. The same rules apply to the default address, a game's
  `scoreboard` (create and update) and `POST /api/admin/scoreboard/test`.

**Which games.** An admin stores a default box address (`settings` row
`scoreboard.defaultAddress`); each game has `scoreboard` = `default` | `off` | its own
address. The feed drives a game only while it is **live**, its sport is **basketball or
volleyball**, and its **home team is the school's team** (name or code equal to
`HOME_TEAM_NAME` / `HOME_TEAM_CODE`). Of several live games on one box, the one **started
last** wins (an earlier game someone forgot to end must not take the new game's scores); the
others show `standby` and are switched to scoring by hand for good (`scoreboard_mode` event
without a user, reason "a newer game took the scoreboard"), so they don't get the box - and the
newer game's scores - back when it ends; only a scorekeeper's **Use the scoreboard** does that.
If the winner is scored by hand, nobody gets the feed. Such a game also starts by itself at
its time once the scoreboard is on, and ends by itself at the final horn (below); a person
can still start and end any game.

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

Guards against the console moving on before the app does, or not yet:
* **Console reset**: the console back at period/game 1 with lower scores (volleyball: game 1
  at 0-0) while the game is further on means it was set up for the next game before this one
  was ended. Nothing of it is applied; after 30 s the game is switched to scoring by hand
  (reason "the scoreboard was reset for another game") with its score intact, for the
  scorekeeper to end. If the scorekeeper then chooses **Use the scoreboard**, the check is
  off for that game.
* **The game before**: right after a start (by a person or by the scoreboard) the console may
  still show the game before - its final, not reset yet, sent in full each time a warm-up
  clock stops. While a game is at its start (first period, 0-0), a reading that shows the
  game before lends it only the clock: its period and score are not applied, and
  `scoreboard.message` is "The scoreboard still shows the game before: this game's score and
  period are read once the console is reset for it. Only the clock is read until then."
  ("points and set" for volleyball, no clock sentence without a clock). A reading shows the
  game before when its period is at or beyond the last period of the latest game of that
  sport that ended (final, or canceled while live) on this scoreboard before this game
  started and got past its first period, or either team's score is at or beyond that game's
  (non-zero) score there (volleyball: the points in the set the console was on). For a game
  the scoreboard started (nobody saw the console then) any period after the first also
  counts, whatever the game before was. The check is over once the console has shown 0-0 in
  the first period, or the game has taken a score (it left 0-0): a reset in steps (the period
  first, then the scores, or the other way) is taken once it is complete, and as the game is
  still in its first period the reset is never mistaken for a reset for another game. **Use
  the scoreboard** (after **Score by hand**) turns the check off: what it shows is what the
  scorekeeper wants. What the check goes by comes from the database (the start event,
  `scoreboard_mode` events, ended games), so it works the same after a restart.
* **Volleyball clear**: points cleared to 0-0 in the same game take the console's record of
  that game when it has one; otherwise they are held for 20 s (for good on the match's last
  set, and while a won match waits for its final-horn hold), so a finished set keeps its
  score when the operator clears the board before moving on.
* **Volleyball beyond the match**: a game number past the match's last set is ignored, and so
  are its points; so is the console moving on to the next game number once the match is won
  (the finished sets, or the current set once won, decide it), so a won best-of-3 never ends
  3-0.

**Starting by itself.** A scheduled game starts by itself when all of these hold:
* it is eligible (basketball or volleyball, the school's team at home), its `scoreboard`
  resolves to an address, and it isn't set to be scored by hand (`scoreboardManual`);
* its time has come: `scheduledAt` ≤ now < `scheduledAt` + 3 h (`AUTO_START_WINDOW_MS`);
* no live game holds that scoreboard: neither one it drives nor one a **person** switched to
  scoring by hand (the gym is in use either way), nor one whose scoreboard was set to **Off**
  after the scoreboard read it (it holds the default scoreboard). A game the feed itself
  handed over to scoring by hand - the console was reset for another game, or a newer game
  took the scoreboard - holds nothing;
* it is the game to start there: of several due games on one scoreboard, the one with the
  latest `scheduledAt` (tie: the lower id). A game is passed over for good once a game
  scheduled no earlier on that scoreboard has started since its time came, so it never
  starts after that game ends;
* the scoreboard is on: a valid RTD data frame arrived within the last 5 s.

While a scoreboard has such a due game and no live game holds it, the server opens its feed
(TCP connection, or UDP port) only to watch: nothing is applied to any game until it starts.
The feed is closed again as soon as no game qualifies (its window passed; the game was
edited, canceled or deleted, set to **Off** or **Score by hand**). The check runs on every
5 s tick and whenever frames arrive (after the 150-500 ms debounce), so a game starts within
about a second of the console sending data, or within 5 s of its time when the console is
already on. It is re-checked inside the start's transaction against the database, then the
game starts exactly like **Start game** (status `live`, `startedAt`, `changed` and `started`
hooks: SSE, push-to-start fan-out to every registered device, broadcast channels) with no
user: `scorekeeper` stays null (any scorekeeper can claim it), the `start` event has no
`user_id` and data `{ "auto": true, "reason": "scoreboard" }`, and the log says "game started
by the scoreboard". The feed then drives the game as usual: the scoreboard wins. A watch
that opens a new connection starts from an empty block, so right after the start typically
only the clock is known; the score and period follow when they change or the clock stops. A
live game's feed that turns into a watch as the game ends keeps its block. Either way, what
still shows the game before (its final, the console not reset yet) is held back by the
guard above: the new game takes only the clock (a warm-up clock running shows as the game
clock until the operator sets it; a 0:00 left from the game before until the console is
reset), so a doubleheader's second game never starts with the first game's score, a warm-up
clock running out at the old "4th quarter" is no final horn, and the operator's **New game**
is applied, not held as a reset for another game. A change the table makes to the first
game's final on the console after that game ended (a correction, late free throws more than
2 minutes after the horn) goes into neither game: an admin corrects the final. To keep a game
from starting by itself: set its scoreboard to **Off**, or **Score by hand** before the start
(both exist already; there is no other switch).

The scorekeeper's `scoreboard.message` for a scheduled game (`state` stays `idle` for every
game that hasn't started; clients rely on it):
* before its time: "Starts automatically at 5:00 PM once the scoreboard at 10.20.1.50:10001
  is on." (time in `SCHOOL_TIMEZONE`);
* due and watched: "Starts automatically once the scoreboard is on. " + the feed's status
  ("Connected to 10.20.1.50:10001, waiting for data from the scoreboard console."), then
  "The scoreboard is on: starting…";
* due while another live game holds the scoreboard: "Starts automatically once Girls JV
  Basketball (Marquette vs Lincoln) has ended: that game is still live on this scoreboard.";
* due, but another due game starts first: "Not started automatically: Boys Varsity
  Basketball (Marquette vs Lincoln), scheduled later on this scoreboard, starts instead.";
* passed over: "Won't start by itself: Boys Varsity Basketball (Marquette vs Lincoln) started
  on this scoreboard after this game's time. Start it by hand if it is played, or cancel it.";
* more than 3 h past its time: "Won't start by itself any more: its time was more than 3
  hours ago. Start it by hand if it is played, or cancel it."

**Final horn.** While the scoreboard drives a game (`controlling`), the game ends by itself
2 minutes (`FINAL_HORN_HOLD_MS`) after it is over on the scoreboard, judged on the game's
state after each reading:
* basketball (points mode, game clock on): the 4th quarter or any overtime, the clock stopped
  at 0:00, the totals not tied - and the clock has run in that period (from the event log,
  so it holds across a restart): 0:00 right after the console moved on to the 4th quarter is
  a clock not set yet, not the horn;
* volleyball: a team has won the match, `ceil(bestOf / 2)` sets: the finished sets as §5
  counts them (`i < period`, higher points), plus the current set once it is won (25 points
  by 2, the deciding set too, as IHSA plays it; `SET_POINTS` in `server/games.js`) - counted
  only if points were scored in it after the set began, so the last set's points still
  showing when the console moves on to the next game are not a win. A deciding set played to
  15 (NFHS outside Illinois) never counts as won: such a match is ended by hand.

When the conditions first hold, a hold starts. Any score change during it (free throws after
the horn) starts it again; the game going on cancels it (time put back on the clock, the
clock set for overtime, another period, a tie). When it completes, the game ends through
`GameService.end` with no user (`auto: true`; event data `{ "auto": true, "reason": "final
horn" }`; re-checked inside the transaction: still driven by the scoreboard, still over),
then the end broadcast as usual (§8.3), and the scoreboard is free for the next game. If the
console is set up for the next game while the hold runs - in any order: the period (game
number) moved back, or a team's score cleared to 0 (volleyball: points cleared to 0-0 are
held instead, as above) - the game ends at once with the score it had: the reading is never
applied and the game is never handed over to scoring by hand. During the hold
`scoreboard.message` gives the end, rounded up to the minute, in `SCHOOL_TIMEZONE`, and isn't
republished as time passes (only when the hold starts again): "Final horn: the game ends by
itself by 7:43 PM, 2 minutes after the last score change. Time put back on the clock keeps it
going." (volleyball "Match won: the game ends by itself by 7:43 PM, 2 minutes after the last
point.").
Games scored by hand never end this way, nor games without a game clock (or an overtime
without one); `AUTO_FINAL_HOURS` still ends forgotten games. Holds live in memory and their
timers are cleared when the game ends, is scored by hand, loses the feed, or the service
stops; a hold that is over ends the game on the next tick even if the console went quiet;
after a restart the next reading starts a new hold.

So on a game night, a girls' game at 5:00 ending at the horn frees the scoreboard, and the
boys' game scheduled at 6:30 starts by itself once the console is on at 6:30 (at once, if the
girls' game ends after 6:30 with the console on: at 0-0, its score and period read once the
console is reset for it).

**Screens.** Admin console → System: the default address, **Test connection** (what the
box sends right now) and the open feeds (live games', and watches for games due to start); the game form: Use the default / Another scoreboard
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
game a box drives or is watched for (status, `scoreboard`, the manual switch, sport, home
team, start, scheduled time), the feed is re-decided before the change is published, so the response, the SSE event and the
next action's 409 check agree. Changing the default address republishes every scheduled or
live game on the default. A scheduled game's status is republished when its time comes or
its window passes (on the tick), and when the game holding its scoreboard, or the game to
start first there, changes.

**TCP connections.** Opened only while a game needs the feed (or a game due to start is
watched for), closed after; never written to
(the Lantronix would pass the bytes into the console). TCP keepalive; reconnect after 2, 5,
10, 20 then every 30 s (the backoff resets only once the box sends valid frames); reconnect
after 90 s without data; `waiting` after 15 s without data. A feed watching for a game to
start renews its connection after 90 s without data instead - the console is just off - at
once, without an error, `unreachable` or backoff, and without publishing a status change
(only a renewal that fails is reported, like any failed connection). The reader drops garbage in linear
time. A reconnect, or another game taking over the box, starts from an empty block. The box
accepts **one TCP connection at a time**: if another system (e.g. a Daktronics video system)
holds it, the server is refused (`unreachable`, "connection refused: the box isn't accepting
connections on this port. It may use another port, send over UDP instead, or already be
connected to another system (it accepts one connection at a time)").
`POST /api/admin/scoreboard/test` reuses the feed's connection (a live game's, or a watch) when there is one.

**UDP feeds.** One socket per port, bound without an address (on Linux a socket bound to an
address never receives subnet broadcasts), shared by every feed and test on that port: each
gets only the datagrams from its box's IP, so two boxes can send to one port. The socket is
opened when the first feed or test needs the port and closed when the last one leaves (a
game ending, scoring by hand, `stop()`). Datagram boundaries don't line up with RTD frames:
every datagram from the box goes into the feed's one reader. **Nothing is ever sent** (no
`send`, `connect` or `setBroadcast`): a datagram to the box goes out its serial port into the
console, and a box with Remote IP 0.0.0.0 would redirect its output to the last sender, away
from Daktronics' own PC. States (the same strings as over TCP, so the app needs nothing new):
* `connecting` — binding the port: "Starting to listen for the scoreboard on UDP port 21000…";
* `unreachable` — the port can't be bound (or the socket failed): "Can't listen for the
  scoreboard on UDP port 21000: <error>. Retrying." (`EADDRINUSE` "another program on this
  server is using that UDP port", `EACCES` "the server isn't allowed to use that port");
  retried with the TCP backoff;
* `waiting` — bound: "Listening on UDP port 21000, waiting for data from the scoreboard at
  10.20.1.50.";
* `receiving` — as over TCP.

A UDP feed never reconnects: after 15 s without data it shows `waiting` again and keeps its
socket and its block (only another game taking over the feed starts from an empty block).
Nothing arrives unless the server's firewall lets it in: ufw's default deny silently drops
unsolicited UDP, broadcasts included (`sudo ufw allow proto udp from <box-ip> to any port
<port>`). A box whose netmask is the class default (/8 for 10.x) broadcasts to
10.255.255.255, which a /24 Linux host doesn't deliver to its sockets.

**Test connection** (`POST /api/admin/scoreboard/test`, admin console → System) listens for
`testListenMs` (5 s) after connecting or binding, or until 2.5 s after the first valid frame,
and returns `{ result }`:
* every result: `address` (canonical), `transport` (`tcp` | `udp`), `inUse`, `gameId` (when
  `inUse`), `connected`, `receiving` (valid frames arrived), `error`, `bytes`, `frames`,
  `badFrames`, `reading`, `listenedMs` (how long it listened after connecting/binding; 0 if
  it never did);
* TCP: `closedByBox` — true when the box ended or reset the connection before the test was
  done; `error` then says so ("the box closed the connection") although `connected` is true;
* UDP: `connected` means the server is listening on the port; `datagrams` (from the box's
  IP); `otherSources` — up to 5 other source IPs seen on that port during the test,
  `[{ address, datagrams }]`, most datagrams first (a box sending from another address shows
  up here); `firewallHint` — `"sudo ufw allow proto udp from 10.20.1.50 to any port 21000"`.

If a feed already uses that exact address, the result describes that feed (`inUse: true`,
`gameId`, and `watching`: true when the feed only watches for a scheduled game to start,
`gameId` then being that game; over UDP `otherSources` is then empty). A UDP test on a port a feed for a
**different** box already has bound shares that socket: it never binds twice and never
disturbs the feed.
