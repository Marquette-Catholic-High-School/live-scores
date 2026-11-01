# Verified platform facts (October 2026)

Facts the live-score system depends on, checked against Apple's documentation,
WWDC sessions, Apple staff forum answers, Node.js release data and vendor docs.
Each critical claim was independently re-verified. Where Apple's own pages
contradict each other, the resolution is noted.

## APNs — authentication (token based, `.p8`)

* JWT header `{"alg":"ES256","kid":"<Key ID>"}`, claims `{"iss":"<Team ID>","iat":<unix seconds>}` — nothing else.
  Send as `authorization: bearer <jwt>`.
* Sign with the `.p8` key, ES256, **IEEE-P1363 (raw r‖s, 64 bytes)** signature:
  `crypto.sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' })`, base64url.
* Cache the token; regenerate **every ~50 minutes** (Apple: no more than once per 20 min,
  no less than once per 60 min). A new token more often than every 20 min on one
  connection → `429 TooManyProviderTokenUpdates`; `iat` older than 1 h → `403 ExpiredProviderToken`.
* The same key/JWT works for device pushes, broadcast pushes and channel management.
  Team-scoped keys can be restricted to Sandbox or Production — the key must be valid
  for each environment you call (`403 BadEnvironmentKeyIdInToken` otherwise).
* Until the first request with a valid token succeeds, APNs allows only one HTTP/2 stream.

## APNs — connections

* HTTP/2 + TLS 1.2+. Keep connections open for hours/days; send an HTTP/2 PING when
  idle (~1 h). Never open/close per request — APNs may treat it as abuse and block.
  Reconnect with backoff.
* Node `http2`: after a `goaway` the session is *closed* but not necessarily *destroyed*
  — drop the cached session on `goaway`, `frameError`, `error`, `close` and treat
  `session.closed || session.destroyed` as dead. `session.request()` never throws for a
  dead session; it emits `ERR_HTTP2_GOAWAY_SESSION` / `ERR_HTTP2_INVALID_SESSION` on the
  stream — retry once on those, `NGHTTP2_REFUSED_STREAM` and `ECONNRESET`. `request()`
  has no timeout: add one per request (e.g. 15 s).
* Node's bundled CA store already trusts APNs' USERTrust RSA root.

| Purpose | Development (sandbox) | Production |
| --- | --- | --- |
| Device pushes incl. push-to-start (`POST /3/device/<hex token>`) | `api.sandbox.push.apple.com:443` (or 2197) | `api.push.apple.com:443` (or 2197) |
| Broadcast send (`POST /4/broadcasts/apps/<bundleId>`) | `api.sandbox.push.apple.com:443` | `api.push.apple.com:443` |
| Channel management (`/1/apps/<bundleId>/channels`, `/all-channels`) | `api-manage-broadcast.sandbox.push.apple.com:2195` | `api-manage-broadcast.push.apple.com:2196` |

(Apple's broadcast page also shows a sample host `api-broadcast.*` and a path without the
leading slash — use the documented hosts above and `/4/broadcasts/...`.)

## APNs — broadcast channels (iOS 18+)

* **Enable "Broadcast Capability"** for the App ID in the developer portal:
  Certificates, IDs & Profiles → Identifiers → `org.marquettecatholic.app` → Push
  Notifications → Broadcast Capability. It cannot be enabled from Xcode. Without it every
  channel call returns `400 FeatureNotEnabled`. Disabling it later deletes all channels.
* **Create**: `POST /1/apps/<bundleId>/channels`, body
  `{"message-storage-policy": 0, "push-type": "LiveActivity"}` (exact value `LiveActivity`).
  `201`, empty body; the id is in the **response header `apns-channel-id`** (base64 string —
  may contain `+ / =`; don't assume its length).
* **Read**: `GET /1/apps/<bundleId>/channels` with request header `apns-channel-id` → `200`.
* **Delete**: `DELETE /1/apps/<bundleId>/channels` with request header `apns-channel-id` → `204`.
  Irreversible. Don't send to a deleted channel.
* **List**: `GET /1/apps/<bundleId>/all-channels` → `200 {"channels": ["…", …]}`.
* Up to **10,000 channels per environment** (`400 CannotCreateChannelConfig` beyond) —
  delete each game's channels after the game.
* Channels are per environment: a sandbox channel can't be used in production
  (`400 ChannelNotRegistered`).
* `message-storage-policy`: `0` = **No Message Stored** — delivered only to devices
  connected at send time, **higher publishing budget, Apple's recommendation for sports
  scores**; `1` = Most Recent Message Stored (latest kept up to 8 h for offline devices,
  lower budget). Cannot be changed after creation. We use **0** (configurable).
* **Broadcast send**: `POST /4/broadcasts/apps/org.marquettecatholic.app` (bare bundle id —
  a `.push-type.liveactivity` suffix → `400 TopicDisallowed`). Headers:
  `authorization`, `apns-channel-id`, `apns-push-type: liveactivity`,
  `apns-priority: 10|5`, **`apns-expiration: 0`** (required; any non-zero value on a
  No-Message-Stored channel → `400 BadExpirationDate`), optional `apns-request-id` (UUID).
  No `apns-topic`. Body = normal Live Activity `aps` payload (update or end), max
  **5,120 bytes**, uncompressed. `200` + `apns-unique-id`.
* **Broadcast cannot start a Live Activity** — only update/end.
* No published rate limit. Apple DTS: limits are dynamic, throttled requests get
  `429 TooManyRequests`. One developer saw throttling above ~4–8 updates/min per channel.
  → coalesce updates and back off on 429.

## APNs — Live Activity pushes

* **Push-to-start** (one per device, to the device's push-to-start token):
  `POST /3/device/<hex token>`, headers `apns-push-type: liveactivity`,
  `apns-topic: org.marquettecatholic.app.push-type.liveactivity`, `apns-priority: 10`.
  Payload (all inside `aps`): `"event": "start"`, `"timestamp"` (unix seconds),
  `"attributes-type": "GameActivityAttributes"` (bare Swift struct name),
  `"attributes": {…}`, `"content-state": {…}`, an **`alert` with nested
  `{"title": "…", "body": "…"}`** (required for start; flat `loc-key` forms reportedly fail),
  and on iOS 18+ **`"input-push-channel": "<base64 channel id>"`** (sibling of
  `attributes-type`) so the new activity listens to the game's broadcast channel. The
  channel must exist first. Optional: `stale-date`, `relevance-score`.
  (`"input-push-token": 1` is the per-activity-token alternative — one push type per activity.)
* **Update/End**: `"event": "update" | "end"`, `"timestamp"`, `"content-state"`, optional
  `"stale-date"` (unix s), `"relevance-score"`, `"alert"`; end may carry
  `"dismissal-date"` (unix s; past = remove now; otherwise removed at that time or 4 h after
  end, whichever is first). Without it an ended activity stays up to 4 h.
* Keep `timestamp` **strictly increasing** per activity (older/equal timestamps are
  assumed ignored).
* Priority 10 = immediate but draws from a per-device hourly budget (excess silently
  dropped even though APNs returns 200); priority 5 = opportunistic, not budgeted. Mix:
  10 for score/period/status changes, 5 for minor ones. `NSSupportsLiveActivitiesFrequentUpdates`
  raises the budget.
* Errors meaning "drop this device token": `410 Unregistered`, `410 ExpiredToken`,
  `400 BadDeviceToken` (also wrong environment), `400 DeviceTokenNotForTopic`. Don't retry
  those; retry `429` with delay and `5xx` later with backoff. Error body `{"reason": "…"}`.
* Payload limits: device pushes 4,096 bytes; broadcast 5,120 bytes; and ActivityKit caps
  attributes + content-state at **4 KB combined**.

## ActivityKit / WidgetKit (client)

* `Activity.request(attributes:content:pushType:)` with `pushType: .channel(channelId)`
  (`PushType.channel(_:)` iOS 18.0+). Only works in the foreground. Errors include
  `.denied`, `.targetMaximumExceeded` (per-app cap, undocumented, ~5 reported),
  `.globalMaximumExceeded`, `.attributesTooLarge`. Invalid channel id → fails to start.
* `Activity<T>.pushToStartToken: Data?` and `pushToStartTokenUpdates` (iOS 17.2+).
  You don't need to start an activity to get one. **Known timing bug before iOS 26**:
  updates may be missed at launch — start observing in `didFinishLaunching`, and also read
  the static `pushToStartToken` after a short delay (Apple's advice). Tokens are per APNs
  environment (dev-signed builds → sandbox).
* Push-to-start launches the app in the background; attach `Activity<T>.activityUpdates`
  observers at launch. Channel-based activities need no per-activity token upload.
* Payload decoding uses a default `JSONDecoder`: keys must equal Swift property names
  (case-sensitive), extra keys are ignored, a missing key or `null` for an **Optional**
  property → `nil`, a missing key for a non-optional property **fails the whole push**
  (even if it has a default value). **Don't use `Date`** in attributes/content-state
  (decoded as seconds since 2001); send unix-second `Double`s and convert in the widget.
* `Text(timerInterval: ClosedRange<Date>, pauseTime: Date? = nil, countsDown: Bool = true, showsHours: Bool = true)`
  (iOS 16+) — running clock: `Text(timerInterval: now...endsAt, countsDown: true)`; never
  build a reversed range. Paused: static formatted text, or `pauseTime: now`. The view
  expands to full width inside Live Activities — constrain with `.frame`.
  `ProgressView(timerInterval:)` has no pause — use `ProgressView(value:total:)` when paused.
* Build settings exist for both plist keys: `INFOPLIST_KEY_NSSupportsLiveActivities` and
  `INFOPLIST_KEY_NSSupportsLiveActivitiesFrequentUpdates` (app target).
  Users can switch frequent updates off (`ActivityAuthorizationInfo().frequentPushesEnabled`).
* Live Activities run ≤ 8 h, then stay on the Lock Screen ≤ 4 h more (12 h total).
* `ActivityAuthorizationInfo().areActivitiesEnabled` + `activityEnablementUpdates`.
* Simulator (Apple silicon): local `Activity.request` works and real sandbox APNs pushes
  arrive; `simctl push` does **not** support liveactivity pushes.
* The widget extension's deployment target must be ≤ the lowest iOS that should show the
  Live Activity — at 26.5 it was silently missing on iOS 18.6–26.4.

## Server platform

* **Node.js** (2026-10-30): Node 26 = Active LTS (since 2026-10-28, v26.13.0, EOL 2029-04-30);
  Node 24 = Maintenance LTS (v24.22.2, EOL 2028-04-30). Production installs **Node 26** via
  NodeSource; the code also runs on Node ≥ 24.
* NodeSource: `curl -fsSL https://deb.nodesource.com/setup_26.x -o nodesource_setup.sh && bash nodesource_setup.sh && apt-get install -y nodejs`
  (pin the major — `setup_lts.x` still points at 24). Works on Ubuntu 24.04/26.04 and
  Debian 12/13 (amd64/arm64). Ubuntu 26.04 uses sudo-rs — run the script as root, not via `sudo -E`.
* `node:sqlite`: `import { DatabaseSync } from 'node:sqlite'` (works on 24 and 26; 26.11+
  also exports `Database`). No flag needed. Node 24.0–24.14 print an ExperimentalWarning
  (use `--disable-warning=ExperimentalWarning`). No transaction helper — use
  `exec('BEGIN IMMEDIATE')` / `COMMIT` / `ROLLBACK`. `PRAGMA journal_mode=WAL` works; the DB
  directory must be writable (WAL/SHM files). Constructor option `timeout` = busy timeout ms.
* **Caddy** (official repo, 2.11.x; distro packages are 2.6.2 — too old):
  ```
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
  ```
  Config `/etc/caddy/Caddyfile`, `systemctl reload caddy`. A site block with a domain gets
  automatic HTTPS + HTTP→HTTPS redirect. `reverse_proxy 127.0.0.1:8080` sets
  `X-Forwarded-For/Proto/Host`. **SSE needs no special config** (`text/event-stream` is
  flushed immediately). Set global `{ email you@school.org  grace_period 10s }` — the email
  enables the ZeroSSL fallback issuer; the grace period makes reloads close old SSE
  connections (clients reconnect). HTTP/3 is on by default (UDP 443).
* ACME needs **80/tcp and 443/tcp open to the whole internet** (Let's Encrypt validates
  from undisclosed IPs). Only SSH should be source-restricted.
* **ufw**: `ufw default deny incoming; ufw default allow outgoing; ufw allow proto tcp from <CIDR> to any port 22` (or `ufw limit 22/tcp`) **before** `ufw --force enable`;
  then `ufw allow 80/tcp; ufw allow 443/tcp; ufw allow 443/udp`. Not installed by default on Debian.
  Cloud security groups must be opened separately.
* **Outbound** the server needs: TCP 443 (or 2197) to `api.push.apple.com` /
  `api.sandbox.push.apple.com`; **TCP 2195 and 2196** to `api-manage-broadcast(.sandbox).push.apple.com`
  (Apple's IPv4 range is 17.0.0.0/8); 443 to Let's Encrypt/ZeroSSL, apt mirrors,
  deb.nodesource.com, dl.cloudsmith.io; UDP 123 (NTP — JWT `iat` and clocks need correct time);
  DNS. No HTTPS interception on the path to Apple.
* **Time sync defaults**: since Ubuntu 25.10 (so on fresh Ubuntu 26.04 installs) chrony with
  NTS is the default: `pool 1.ntp.ubuntu.com` … `4.ntp.ubuntu.com` plus
  `ntp-bootstrap.ubuntu.com` (`/etc/chrony/sources.d/ubuntu-ntp-pools.sources`); NTS key
  exchange uses **TCP 4460** in addition to UDP 123. Releases upgraded to 25.10+ keep
  systemd-timesyncd. (Ubuntu Server docs, "Synchronize time using chrony".)
* **systemd** hardening for Node: `NoNewPrivileges=yes`, `ProtectSystem=strict`,
  `ProtectHome=yes`, `PrivateTmp=yes`, `PrivateDevices=yes`, `ProtectKernelTunables=yes`,
  `ProtectKernelModules=yes`, `ProtectControlGroups=yes`, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`,
  `RestrictNamespaces=yes`, `LockPersonality=yes`, `CapabilityBoundingSet=` (empty),
  `StateDirectory=mchs-live` (creates `/var/lib/mchs-live` owned by the service user),
  `LimitNOFILE=65536`. **Never `MemoryDenyWriteExecute=yes`** (breaks V8's JIT).
  (The installer's unit also allows `AF_NETLINK`, which glibc/libuv use to list local
  addresses, and raises `LimitNOFILE` to `SSE_MAX_CONNECTIONS` + 8192 when that is
  higher, capped at the kernel's default `fs.nr_open` of 1048576.)
  `EnvironmentFile=` is read by systemd itself (the file can be root-only).
  Optional: `LoadCredential=apns.p8:/etc/mchs-live/AuthKey_XXXX.p8` exposes the key at
  `$CREDENTIALS_DIRECTORY/apns.p8` (`%d/apns.p8` in the unit) to the service user only.
* **Sizing** (engineering estimate): broadcast pushes make Apple do the fan-out, so load is
  tiny — 1 vCPU / 1 GB RAM / 10 GB disk minimum; 2 vCPU / 2 GB RAM / 25 GB SSD recommended,
  plus 1–2 GB swap.
