# MCHS Live Scores server

Live scores for the Marquette Catholic High School app, hosted on the school's own
server. Scorekeepers enter scores in a web portal (or in the iOS app); the server
shows them instantly on the public scoreboard and in the app, and puts a **Live
Activity** on the Lock Screen and Dynamic Island of every iPhone with the app (unless its
owner turned **Live Activities** off in the app). Home basketball and volleyball games
can run on their own from the gym's scoreboard: they start at their time once the
scoreboard is on, and end at the final horn. It runs on one small Linux VM with no Firebase and no other
cloud services: one Node.js process, an SQLite database file, and Caddy for HTTPS
(or, if you prefer no open ports, a [Cloudflare Tunnel](#53-cloudflare-tunnel-instead-of-open-ports)).
Apple's push service (APNs) does the heavy lifting of delivering updates to phones.

```
                 ┌──────────────────────── your VM ────────────────────────┐
  browsers,      │                                                          │
  iOS app  ──────┼─► Caddy :443/:80 ──► Node.js server 127.0.0.1:8080       │
  (HTTPS)        │   (HTTPS, Let's       ├─ web portal + REST API           │
                 │    Encrypt)           ├─ live stream (Server-Sent Events)│
                 │                       ├─ SQLite  /var/lib/mchs-live      │
                 │                       └─ APNs client ────────────────────┼──► Apple Push
                 └──────────────────────────────────────────────────────────┘    Notification
                                                                                   service ──► iPhones
```

The API, data model and push details are specified in [ARCHITECTURE.md](ARCHITECTURE.md);
verified Apple/APNs facts are in [RESEARCH.md](RESEARCH.md).

**Quick start** on a fresh VM (details in [section 5](#5-install)):

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/Marquette-Catholic-High-School/live-scores.git ~/live-scores
cd ~/live-scores && sudo ./deploy/install.sh
```

**Contents:** [VM specs](#1-vm-specs) · [Ports](#2-ports) · [DNS](#3-dns) ·
[Apple Developer setup](#4-apple-developer-setup) · [Install](#5-install) ·
[First login](#6-first-login-and-scorekeeper-accounts) · [iOS app](#7-point-the-ios-app-at-the-server) ·
[Game day](#8-how-game-day-works) · [Verify APNs](#9-verify-apns) · [Operations](#10-operations) ·
[Troubleshooting](#11-troubleshooting) · [Security](#12-security-notes) ·
[Local development](#13-local-development)

---

## 1. VM specs

|                  | Minimum                                   | Recommended                              |
| ---------------- | ----------------------------------------- | ---------------------------------------- |
| vCPU             | 1                                         | 2                                        |
| RAM              | 1 GB                                      | 2 GB, plus 1–2 GB swap                   |
| Disk             | 10 GB                                     | 25 GB SSD                                |
| Operating system | Ubuntu 24.04 LTS or 26.04 LTS, Debian 12 or 13 (64-bit, with systemd) | Ubuntu 24.04 LTS or 26.04 LTS |
| CPU architecture | x86_64 (amd64) or arm64                   | either                                   |
| Public IPv4      | 1 static address (required; not needed with a [Cloudflare Tunnel](#53-cloudflare-tunnel-instead-of-open-ports)) | 1 static address |
| IPv6             | optional                                  | optional (add an AAAA record if you use it) |

The installer checks this before changing anything: it refuses other OS releases
(unless `--skip-os-check`), other CPU architectures, systems without systemd (e.g.
plain containers) and less than 1 GB free on `/`, and warns below 1 GB RAM, below
2 GB RAM without swap, and below 3 GB free disk. With Caddy, ports 80 and 443 must not
be in use by another web server (apache2, nginx).

**Why so small:** score updates go to Apple as *broadcast* pushes: one request per
update per environment, and Apple fans it out to every phone. Only a game's start
sends one push per registered phone, over a single HTTP/2 connection. The live
scoreboard uses one lightweight connection per open browser tab or app screen.
The database is a few megabytes. Disk space is mostly the OS, logs and 14 days of
backups. Swap protects the box from memory spikes during OS upgrades on 1–2 GB VMs:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Any provider works (Azure, AWS, Google Cloud, DigitalOcean, an on-prem hypervisor),
as long as the VM can be reached from the internet on ports 80 and 443. With a
Cloudflare Tunnel it only has to reach Cloudflare outbound (section 5.3).

## 2. Ports

This section is for the standard setup with Caddy. With a Cloudflare Tunnel, no inbound
port is needed except SSH. Section 5.3 lists the outbound changes.

### Inbound (from the internet to the VM)

| Port | Protocol | Allow from | Purpose |
| ---- | -------- | ---------- | ------- |
| 80   | TCP | **anywhere** | Let's Encrypt certificate validation, then redirect to HTTPS. Must be open to the whole internet: Let's Encrypt validates from undisclosed addresses. |
| 443  | TCP | **anywhere** | HTTPS: web portal, API, live score stream (browsers and the iOS app). |
| 443  | UDP | anywhere | HTTP/3 (QUIC). Optional; clients fall back to TCP 443. |
| 22   | TCP | **your admin network only** | SSH (or your custom SSH port). |
| 8080 | TCP | **nobody - do NOT expose** | The Node.js server listens on 127.0.0.1 only. Never open or port-forward it. |

The installer configures `ufw` on the VM to exactly this (SSH restricted with
`--ssh-from`, otherwise rate-limited). If your cloud has its own firewall or security
group, open the same ports there too: the installer can't change those. If the gym's
scoreboard box sends its data over UDP (section 8.1), you add one more rule yourself, for
that box's address only; re-running the installer keeps it.

### Outbound (from the VM)

| Destination | Port | Why |
| ----------- | ---- | --- |
| `api.push.apple.com` (production), `api.sandbox.push.apple.com` (sandbox) | **TCP 443** (Apple also accepts 2197; the server uses 443) | Live Activity pushes: push-to-start, broadcast updates and ends |
| `api-manage-broadcast.push.apple.com` | **TCP 2196** | Create/read/delete broadcast channels (production) |
| `api-manage-broadcast.sandbox.push.apple.com` | **TCP 2195** | Create/read/delete broadcast channels (sandbox) |
| `acme-v02.api.letsencrypt.org` (and `acme.zerossl.com` as fallback) | TCP 443 | HTTPS certificates (automatic renewal) |
| OS package mirrors: Ubuntu `archive.ubuntu.com`, `security.ubuntu.com` (arm64: `ports.ubuntu.com`); Debian `deb.debian.org`, `security.debian.org`; or your cloud's own mirror (see `/etc/apt/sources.list.d/`) | TCP 80/443 | OS packages and updates |
| `deb.nodesource.com` | TCP 443 | Node.js (setup script and packages) |
| `dl.cloudsmith.io` | TCP 443 | Caddy (repository key, list and packages) |
| NTP: Ubuntu 24.04 `ntp.ubuntu.com`; Ubuntu 26.04 (chrony with NTS) `1.ntp.ubuntu.com` … `4.ntp.ubuntu.com` and `ntp-bootstrap.ubuntu.com`; Debian `0.debian.pool.ntp.org` … `3.debian.pool.ntp.org`; many clouds point the VM at their own time service instead | UDP 123 (NTS key exchange also **TCP 4460**) | Correct clock (APNs rejects tokens from a wrong clock) |
| Your DNS resolvers | UDP/TCP 53 | Name resolution |

Apple's servers are in 17.0.0.0/8 if your egress firewall needs addresses. Ports
2195 and 2196 are the ones most often blocked by school or cloud egress rules.
There must be **no HTTPS inspection/interception** between the VM and Apple or
Let's Encrypt. Which time servers the VM really uses: `timedatectl show-timesync`
(systemd-timesyncd) or `chronyc sources` (chrony); the installer warns when the clock
is not synchronized.

## 3. DNS

(With a Cloudflare Tunnel, skip this section: Cloudflare creates the record, see 5.3.)

Pick a name such as `live.marquettecatholic.org` and create, at your DNS provider:

* an **A record** pointing at the VM's public IPv4 address, and
* an **AAAA record** for its IPv6 address, only if the VM really has one and port
  80/443 are open on it too.

Use a short TTL (300 s) while setting up. Check it from anywhere with
`dig +short live.marquettecatholic.org`. If your domain has CAA records, they must
allow `letsencrypt.org` (and `sectigo.com` for the ZeroSSL fallback). Create the
record before installing: Caddy requests the certificate as soon as it starts.

## 4. Apple Developer setup

Done once, in the [Apple Developer account](https://developer.apple.com/account) of
team **92KVHUHC4C** (an Account Holder or Admin is needed).

1. **Enable the broadcast capability for the app.** Certificates, Identifiers &
   Profiles → Identifiers → `org.marquettecatholic.app` → make sure **Push
   Notifications** is checked → click *Configure*/*Edit* next to it → enable
   **Broadcast Capability** → Save. This cannot be done from Xcode. Without it every
   channel request fails with `FeatureNotEnabled`. (Turning it off later deletes all
   channels.)
2. **Create an APNs auth key.** Certificates, Identifiers & Profiles → Keys → **+** →
   any name (e.g. "MCHS Live Scores") → check **Apple Push Notifications service
   (APNs)** → *Configure*: choose the environment **Sandbox & Production** (a key
   limited to one environment only works there - see `--apns-environments`) and a
   team-scoped key → Continue → Register → **Download** the `AuthKey_XXXXXXXXXX.p8`
   file. Apple lets you download it **only once**; keep it in your password manager.
   Note the 10-character **Key ID** (also in the file name).
3. The **Team ID** is `92KVHUHC4C` (Membership details); the installer uses it by default.

Which environment a phone uses depends on how the app was built: Xcode builds use
**sandbox**, TestFlight and App Store builds use **production**. Each phone registers
for its build's environment, and the server creates one broadcast channel per game in
each environment it serves (`APNS_ENVIRONMENTS`, installer option `--apns-environments`):
both by default. The key must be valid for every environment served (a "Sandbox &
Production" key), and the App ID's bundle id must match `--bundle-id` (default
`org.marquettecatholic.app`).

## 5. Install

### 5.1 Get the files onto the VM

Copy the APNs key from section 4 from your computer, then sign in to the VM and clone
the repository (it contains `package.json`, `server/`, `public/` and `deploy/`):

```bash
scp AuthKey_ABCDE12345.p8 admin@VM:~/
ssh admin@VM
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/Marquette-Catholic-High-School/live-scores.git ~/live-scores
```

Without internet access to GitHub from the VM, copy the folder from your computer
instead (the `web-portal` folder of the app project holds the same files):
`rsync -av --exclude data --exclude .env --exclude node_modules web-portal/ admin@VM:~/live-scores/`.

### 5.2 Run the installer

```bash
cd ~/live-scores
sudo ./deploy/install.sh
```

It asks for the domain, whether to use Caddy or a Cloudflare Tunnel (section 5.3: choose
2 and paste the tunnel token), an optional e-mail for certificate notices, the school's time
zone (Enter keeps `America/Chicago`, or the zone set earlier), the path of the `.p8`
key (`~/AuthKey_ABCDE12345.p8`; Enter skips it for now - with a new key also its Key
ID, the Team ID and the APNs environments), which addresses may use SSH, and - only
while no admin exists - the first admin's username and password (Enter generates one).
Then it shows a plan and asks before changing anything.

Non-interactive (for automation; most options also exist as `MCHS_*`
environment variables, listed below and in `--help`; an option wins over its variable):

```bash
sudo ./deploy/install.sh --yes \
  --domain live.marquettecatholic.org \
  --email it@marquettecatholic.org \
  --school-timezone America/Chicago \
  --apns-key-path ~/AuthKey_ABCDE12345.p8 \
  --ssh-from 203.0.113.0/24 \
  --admin-username admin
```

Without a password option, `--yes` generates the first admin's password and prints it
once at the end. To choose it in a script, hand it over in a file or a pipe, never as
an argument: sudo writes the whole command line (including `VAR=value` assignments in
front of the command) to `/var/log/auth.log` and the journal, and every local user can
read a running command's arguments with `ps`. For example
`printf '%s\n' "$PW" | sudo ./deploy/install.sh --yes --domain … --admin-password-file /dev/stdin`,
or a file only root can read (delete it afterwards). The installer itself hands the
password to the CLI on stdin as well.

| Option | Variable | Default | Meaning |
| ------ | -------- | ------- | ------- |
| `--domain NAME` | `MCHS_DOMAIN` | (asked; on upgrade the current one) | Public DNS name of the portal |
| `--caddy` / `--cloudflare-tunnel` | `MCHS_HTTPS_MODE=caddy` / `cloudflare-tunnel` | Caddy (on upgrade: the current choice) | HTTPS from this VM with Caddy (ports 80/443 open), or through a Cloudflare Tunnel (no inbound ports, section 5.3). Switching either way is supported |
| `--tunnel-token-file FILE` | `MCHS_TUNNEL_TOKEN_FILE` | asked (on upgrade: the saved one) | The Cloudflare Tunnel token: the first line of `FILE` (`/dev/stdin` for a pipe). Implies `--cloudflare-tunnel`. `MCHS_TUNNEL_TOKEN` (the token itself) works only from a root shell's environment. `--tunnel-token` is refused (it would end up in sudo's log and in `ps`) |
| `--email ADDRESS` | `MCHS_EMAIL` | none | Let's Encrypt contact; also enables the ZeroSSL fallback (`none` removes it). Caddy only |
| `--school-timezone ZONE` | `MCHS_SCHOOL_TIMEZONE` | `America/Chicago` (on upgrade the current one) | The school's IANA time zone for game times (`SCHOOL_TIMEZONE`), e.g. `America/New_York`. It must be a name this VM knows (`timedatectl list-timezones`) and Node.js accepts |
| `--apns-key-path FILE` | `MCHS_APNS_KEY_PATH` | none | `.p8` key on the VM; copied to `/etc/mchs-live/` |
| `--apns-key-id ID` | `MCHS_APNS_KEY_ID` | from `AuthKey_<ID>.p8` | 10-character Key ID |
| `--apns-team-id ID` | `MCHS_APNS_TEAM_ID` | `92KVHUHC4C` | Apple Team ID |
| `--bundle-id ID` | `MCHS_BUNDLE_ID` | `org.marquettecatholic.app` | iOS app bundle id |
| `--apns-environments LIST` | `MCHS_APNS_ENVIRONMENTS` | `production,sandbox` | APNs environments to serve: `production,sandbox`, `production` or `sandbox` |
| `--admin-username NAME` / `--admin-display-name TEXT` | `MCHS_ADMIN_USERNAME` / `MCHS_ADMIN_DISPLAY_NAME` | `admin` / `Administrator` | First portal admin (only created if no admin exists) |
| `--admin-password-file FILE` | `MCHS_ADMIN_PASSWORD_FILE` | asked, or generated | Password of the first admin: the first line of `FILE` (`/dev/stdin` for a pipe), at least 8 characters. A generated one is printed once at the end. `MCHS_ADMIN_PASSWORD` (the password itself) works only from a root shell's environment, never as `VAR=value` on a sudo command line. `--admin-password` was removed and is refused (it would end up in sudo's log and in `ps`) |
| `--ssh-from CIDR[,CIDR]` | `MCHS_SSH_FROM` | anywhere, rate-limited | Allow SSH only from these addresses (`any` lifts an earlier restriction) |
| `--ssh-port PORT` | `MCHS_SSH_PORT` | detected | SSH port to allow |
| `--no-firewall` | `MCHS_NO_FIREWALL=1` | | Leave the VM's firewall alone (open the ports yourself) |
| `--node-major 24\|26` | `MCHS_NODE_MAJOR` | 26 | Node.js line installed when Node is missing or older than 24 |
| `--skip-apns-check` | | | Don't test APNs at the end |
| `--skip-os-check` | | | Continue on an untested OS release (not recommended) |
| `-y`, `--yes` | `MCHS_YES=1` | | Never prompt (without a terminal on stdin the installer never prompts anyway) |
| `-h`, `--help` | | | Show every option |

Options also take the `--option=value` form.

What it does (each step is safe to repeat): checks the OS, free ports and resources;
installs `curl`, `sqlite3`, `rsync`, `ufw`; installs Node.js 26 LTS from NodeSource
and Caddy from its official repository; creates the system user `mchslive`; copies
the app to `/opt/mchs-live` (read-only for the service); writes
`/etc/mchs-live/mchs-live.env`; installs the systemd service `mchs-live` (sandboxed)
and a daily backup timer; configures the firewall; starts the server and waits for
`/api/health`; configures Caddy for your domain; creates the first admin; runs the
APNs check; waits for the HTTPS certificate; and prints a summary with the admin
login, the open ports and the next steps. With a Cloudflare Tunnel it installs and
connects `cloudflared` instead of Caddy (section 5.3).

Re-running it **upgrades** the code and keeps the configuration, database and backups;
it only changes settings you pass as options (or change at the prompts), and it
backs up the database first.

If you get "Permission denied", the copy lost the execute bit: `sudo bash deploy/install.sh`.

### 5.3 Cloudflare Tunnel (instead of open ports)

Instead of giving the VM a public IP address with ports 80 and 443 open, you can put
Cloudflare in front of it. The VM runs Cloudflare's connector, `cloudflared`, which
connects **out** to Cloudflare. Cloudflare serves HTTPS for your domain and passes each
request through that connection to the server on `127.0.0.1:8080`. No inbound port is
opened, and Caddy and Let's Encrypt are not used. The Free plan is enough. Live scores
and Live Activities work the same: pushes go straight from the VM to Apple, not through
Cloudflare.

```
  browsers, iOS app ──HTTPS──► Cloudflare ◄── tunnel ── cloudflared ──► Node.js 127.0.0.1:8080
                                              (opened by the VM, outbound port 7844)
```

**What you need**

* A Cloudflare account. The Free plan is enough.
* **The domain on Cloudflare DNS.** On the Free plan the whole domain moves to
  Cloudflare: its nameservers change to Cloudflare's ("full setup"). Keeping the DNS
  elsewhere and pointing only one name at Cloudflare needs the Business plan ("partial
  setup"). Moving only a subdomain needs Enterprise. If the school's main domain can't
  move, use a separate domain the school owns (for example `mchslive.org`).
* A hostname with **one level** below the domain, such as `live.marquettecatholic.org`.
  Cloudflare's free certificate doesn't cover `live.sports.marquettecatholic.org`.
* **Outbound from the VM:** TCP **and** UDP **7844** to Cloudflare
  (`region1.v2.argotunnel.com`, `region2.v2.argotunnel.com`). The tunnel prefers UDP;
  if UDP is blocked it switches to TCP after about a minute. Also TCP 443 to
  `pkg.cloudflare.com` to install and update `cloudflared`, and TCP 443 to your
  portal's own hostname (Cloudflare), which only the installer's final check uses.
  Everything else from section 2's outbound table stays (Apple, OS mirrors, NodeSource,
  NTP, DNS), except Let's Encrypt and `dl.cloudsmith.io`.
* No public IP address on the VM: a private address behind NAT works.

**1. Create the tunnel** (Cloudflare dashboard)

1. **Networking → Tunnels → Create Tunnel**, name it `mchs-live`, select **Create
   Tunnel**. (The same screens are under Zero Trust → Networks → Connectors.)
2. Under *Setup Environment*, choose Debian and the VM's architecture. The page shows
   install commands that end with `sudo cloudflared service install eyJ…`. **Don't run
   them**: the installer installs and runs `cloudflared` itself. Copy the **token**,
   the long text starting with `eyJ`. Copying the whole last command also works; the
   installer picks out the token. Treat the token like a password: anyone who has it
   can serve your hostname.
3. Continue to the tunnel's **Routes** tab → **Add route → Published application**
   (older screens: *Public hostname → Add a public hostname*). Set subdomain `live`,
   domain `marquettecatholic.org`, service type **HTTP**, URL **`127.0.0.1:8080`**
   (Service URL `http://127.0.0.1:8080`). Use `127.0.0.1`, not `localhost`. Save.
   Cloudflare creates the DNS record itself: a proxied CNAME to
   `<tunnel-id>.cfargotunnel.com`. If an A or AAAA record for `live` exists (DNS →
   Records), delete it first - only that name, never the domain's own record.

**2. Install**

Run the installer as in 5.2: enter the domain, then choose **2** (Cloudflare Tunnel) at
the next question. Paste the token when asked; it isn't shown on screen:

```bash
cd ~/live-scores
sudo ./deploy/install.sh
```

Without prompts, save the token in a file only root can read: paste it, then press
Enter and Ctrl-D. Pass the file to the installer, which keeps its own copy, then delete
the file:

```bash
sudo sh -c 'umask 077; cat > /root/tunnel-token.txt'
sudo ./deploy/install.sh --yes --domain live.marquettecatholic.org \
  --tunnel-token-file /root/tunnel-token.txt \
  --apns-key-path ~/AuthKey_ABCDE12345.p8 --ssh-from 203.0.113.0/24 &&
  sudo rm /root/tunnel-token.txt
```

If the installer stops part-way, fix the problem and run the same command again (the
token file is still there, because `rm` runs only after a successful install).

What changes compared with Caddy:

* The installer adds Cloudflare's apt repository and installs `cloudflared`. Caddy is
  not installed.
* It stores the token in `/etc/mchs-live/cloudflare-tunnel.token` (0600, root only).
* It runs the connector as the service `mchs-live-tunnel`, sandboxed and without root.
  systemd hands it the token as a credential, so the token never appears on a command
  line.
* The firewall gets only the SSH rule; the installer opens no web ports. (Exception: if
  Caddy already serves other sites on this VM, the installer keeps the 80/443 rules it
  added for Caddy earlier, or adds them when it turns the firewall on itself. Rules of
  your own stay as they are.)
* At the end it waits for the tunnel to connect and checks two things: that
  `https://<domain>/` reaches this server through Cloudflare, and that the live score
  stream arrives without buffering.

The summary says what to fix if a check fails. Usually the route from step 1.3 is missing.

**3. Cloudflare settings to check**

These settings are on the domain's pages in the dashboard. They matter because the iOS
app and the live stream are not a browser page and cannot pass Cloudflare's
"are you human" challenges.

| Setting | Where | Set to | Why |
| ------- | ----- | ------ | --- |
| Always Use HTTPS | SSL/TLS → Edge Certificates | **On** | Sends `http://` visitors to HTTPS at Cloudflare (the server also redirects them and never accepts a password over HTTP) |
| Minimum TLS Version | SSL/TLS → Edge Certificates | TLS 1.2 | |
| Encryption mode | SSL/TLS → Overview | anything but **Off** | Off turns off HTTPS at Cloudflare |
| Bot Fight Mode | Security → Settings (Bot traffic) | **Off** | It can challenge the app's requests, and on Free it can't be switched off for `/api/` alone |
| Browser Integrity Check | Security → Settings | Off, or a custom rule: *URI Path starts with `/api/`* → **Skip** → Browser Integrity Check | It challenges clients it doesn't recognize |
| I'm Under Attack mode | Security | Off | Its challenge page breaks the app and the live stream |
| Email Address Obfuscation, Rocket Loader, Cloudflare Fonts | Security → Settings, Speed → Settings | Off | They rewrite pages and inject scripts that the portal's security policy blocks |
| Web Analytics (on by default for Free domains) | Analytics & Logs → Web Analytics → your site | Disable | It injects a tracking script into every page, which the portal's security policy blocks |
| Browser Cache TTL | Caching → Configuration | **Respect Existing Headers** | The default (4 hours) keeps old scripts in browsers long after an upgrade |
| Pseudo IPv4, Managed Transform "Remove visitor IP headers" | Network; Rules → Managed Transforms | Off (the default) | The server's per-address limits need each visitor's real address |
| Rate limiting rules | Security | none | Hundreds of fans share the school's one public address; the server has its own limits |
| HSTS | SSL/TLS → Edge Certificates | leave off | The server sends HSTS for its own hostname. Cloudflare's setting would apply to every name in the domain |

Caching needs nothing else. Cloudflare doesn't cache the API, the pages or the live
stream. It keeps scripts, styles and images for the server's 5 minutes. After an
upgrade, **Caching → Configuration → Purge Everything** shows new scripts and styles
right away instead of within 5 minutes.

**Running it**

* Status: `systemctl status mchs-live mchs-live-tunnel` and
  `curl -s http://127.0.0.1:20246/ready` (`readyConnections` should be 4).
  Log: `journalctl -u mchs-live-tunnel -f`.
* **Update `cloudflared`** at least every few months: Cloudflare supports releases from
  the last 12 months, and apt-installed copies never update themselves. Re-running the
  installer upgrades it, or run
  `sudo apt-get update && sudo apt-get install --only-upgrade cloudflared && sudo systemctl restart mchs-live-tunnel`.
  A restart makes the portal unreachable for about 5-10 seconds (Cloudflare error 1033)
  and cuts open live streams; viewers reconnect on their own. Don't do it during a game.
  If UDP 7844 is blocked, each restart takes about a minute instead, because the
  connector tries UDP first every time. Pin it to TCP with the
  `TUNNEL_TRANSPORT_PROTOCOL=http2` drop-in under Troubleshooting below.
  A re-run of the installer that upgrades `cloudflared` restarts it the same way.
* **New token, routine:** on the tunnel's page in Cloudflare, refresh the token, then
  re-run the installer with `--tunnel-token-file FILE` (or paste it at the prompt).
* **The token leaked:** refreshing it is not enough, because a connector someone already
  started with the old token stays connected and could serve your hostname. Move to a
  new tunnel instead, in this order:
  1. Create a new tunnel with a different name (for example `mchs-live-2`) and copy its
     token (step 1.1-1.2).
  2. Delete the old tunnel's route and the `live` CNAME, then add the route to the new
     tunnel (step 1.3). From now until step 3 finishes, visitors see error 1033.
  3. Right away, run `sudo ./deploy/install.sh --tunnel-token-file FILE` with the new
     token.
  4. Delete the old tunnel, and check that the new one lists only this VM as a connector.
* **Switch from Caddy to the tunnel.** The portal stays up through step 2. From step 3
  until the installer in step 4 has connected the tunnel (a few minutes), visitors see
  error 1033, so do steps 3 and 4 together, and not during a game.
  1. If the domain isn't on Cloudflare yet, add it (full setup), check that the imported
     records include `live`, and set that record to **DNS only** (grey cloud) so Caddy
     keeps serving exactly as before. Change the nameservers and wait until Cloudflare
     shows the domain as Active.
  2. Create the tunnel and copy its token (step 1.1-1.2).
  3. In DNS → Records delete the A and AAAA records for `live` only, then add the route
     at once (step 1.3).
  4. Run `sudo ./deploy/install.sh --cloudflare-tunnel --tunnel-token-file FILE`. It
     removes the portal's Caddy site. If Caddy serves nothing else, it stops Caddy and
     deletes the installer's firewall rules for 80/443. Otherwise both stay for your
     other sites.
* **Switch back:** run `sudo ./deploy/install.sh --caddy`. Once Caddy is running, it
  removes the connector and its token. Then, in Cloudflare DNS → Records, delete the
  `live` CNAME that points to the tunnel and add an A record with the VM's public IP,
  DNS only (grey cloud). Delete the tunnel, and open the ports from section 2 in any
  cloud firewall.
* The uninstaller removes the connector too, and `--remove-packages` also removes
  `cloudflared`. In Cloudflare, delete the tunnel and the `live` CNAME yourself.

**Troubleshooting**

* *The tunnel doesn't connect:* run `journalctl -u mchs-live-tunnel -n 50`.
  Errors about the token mean a wrong or rotated one. Timeouts on port 7844 mean an
  outbound firewall. The warning "failed to sufficiently increase receive
  buffer size" is harmless.
* *Cloudflare error 1033:* no connector is connected. Check
  `systemctl status mchs-live-tunnel`.
* *502 Bad Gateway:* the tunnel works but can't reach the server. The route's URL must
  be `http://127.0.0.1:8080`, and `systemctl status mchs-live` must show it running.
* *Browsers work but the app shows errors:* Cloudflare is challenging the app (Bot Fight
  Mode, Browser Integrity Check, Under Attack). **Security → Events** lists blocked and
  challenged requests.
* *The live stream check failed (installer warning):* first test from a device on another
  network: `curl -N https://live.marquettecatholic.org/api/stream` must print
  `event: hello` at once. If it does, the problem is only between the VM and Cloudflare,
  for example a web filter that inspects HTTPS or an `https_proxy` setting, and
  viewers are not affected. If not, look for a Cache Rule or Page Rule ("Cache
  Everything", Edge TTL) or a Worker covering `/api/`, and remove it for that path.
* *The installer says the portal's address does not resolve:* usually the route from
  step 1.3 is missing (adding it creates the DNS record), or the domain is not Active on
  Cloudflare yet. If both are fine, DNS is still catching up: open the portal from
  another device a few minutes later.
* *The installer says the VM could not connect to the portal's address:* open
  `https://<domain>/api/health` from another network. If that fails too, check the
  route (step 1.3). If it works, outbound HTTPS from the VM to Cloudflare is blocked or
  intercepted, which affects only the installer's check.
* *The live stream freezes until the tunnel restarts:* a known `cloudflared` issue with
  its UDP transport. Switch the connector to TCP:
  `sudo systemctl edit mchs-live-tunnel`, add `[Service]` and
  `Environment=TUNNEL_TRANSPORT_PROTOCOL=http2`, then
  `sudo systemctl restart mchs-live-tunnel`.

## 6. First login and scorekeeper accounts

1. Open `https://live.marquettecatholic.org/` and sign in with the admin account
   from the installer summary. Change a generated password after the first login.
2. In the portal's user management (admins only), create one **scorekeeper**
   account per person who will keep score. Give **admin** only to people who also
   schedule games and manage accounts. Disable accounts when people leave.

The same from the VM's command line:

```bash
sudo mchs-live-cli list-users
sudo mchs-live-cli create-user --username jsmith --display-name "Coach Smith" --role scorekeeper
sudo mchs-live-cli reset-password --username admin       # forgotten admin password
sudo mchs-live-cli delete-user --username jsmith
```

`create-user` and `reset-password` ask for the password on a terminal, or generate and
print one when not run on one. To set a password from a script, pipe it in with
`--password-stdin` (the first line of stdin is the password) and write option values
as `--opt=value`:

```bash
printf '%s\n' "$PW" | sudo mchs-live-cli reset-password --username=admin --password-stdin
```

Don't use `--password=…` on a server: arguments show up in `ps` for every local user,
in sudo's log and in your shell history.

## 7. Point the iOS app at the server

In Xcode, open `MCHS/LiveScoresConfig.swift` and set the server address:

```swift
static let defaultServerURL = URL(string: "https://live.marquettecatholic.org")!
```

`LiveScoresConfig.serverURL` (used for every request) comes from this constant;
while it points at `example.com` the app shows "Live scores aren't set up yet".
Ship a new TestFlight/App Store build. For testing, Debug builds can be pointed
elsewhere without a code change with the launch argument
`-LiveScoresServerURL http://localhost:8080` (Scheme → Run → Arguments).

## 8. How game day works

1. **Schedule** (admin): add the game in the portal: sport, **Boys / Girls** and
   **level** (Varsity, JV, Freshman), teams, time, location. The two make the game's
   label - "Girls JV Basketball", "Boys Varsity Volleyball" - which the portal, the app
   and the Live Activity show as the game's title, so fans can tell the girls' game from
   the boys' game. Leave either one blank: "Girls Basketball", "Freshman Basketball", or
   just "Basketball". You can change the label any time, even during or after the game;
   Live Activities already on Lock Screens keep the label they started with.
2. **Claim** (scorekeeper): sign in on the portal or in the app (Scores → scorekeeper
   button) and claim the game, so only you can score it. (A game the scoreboard starts
   by itself is unclaimed: any scorekeeper can claim it.)
3. **Start**: a home basketball or volleyball game read from the gym scoreboard (8.1)
   **starts by itself at its scheduled time, once the scoreboard is on**. Any other game:
   tap **Start game** (from 2 hours before the scheduled time; admins any time). Within
   seconds a Live Activity appears on every iPhone with the MCHS app and Live Activities
   on - they are on by default; people who don't want them turn **Live Activities** off
   in the app's notification settings (and iOS must allow Live Activities for the app).
4. **Score**: every tap (points, period, clock, outs, notes, undo) updates the
   portal scoreboard and the app instantly; Lock Screens update within a few seconds
   (updates are combined to at most one every 5 s per game to stay within Apple's
   push budget).
   The game clock runs on the phones by itself.
5. **End**: a game the scoreboard drives **ends by itself 2 minutes after the final
   horn**; otherwise tap **End game**. The final score is pushed and the Live Activity
   disappears two hours later. Live games nobody has changed for 4 hours are ended
   automatically.

Anyone can also follow a game from its detail screen in the app with **Show on Lock
Screen**, even with Live Activities turned off in the app.

### 8.1 Scores from the Daktronics scoreboard (optional)

The server can read the gym scoreboard and keep the score, game clock and period up to
date by itself, and start and end those games by itself (see "On game day" below). It works with a **Daktronics All Sport 5000** console whose data output
goes to a **Lantronix** serial-to-Ethernet box (the box Daktronics uses for video
systems), for **basketball and volleyball** games where **Marquette is the home team**.
Volleyball reads the points in the current set, the set number and each finished set's
score. Nothing else is read (no fouls, timeouts or possession), and the server never
sends anything to the box.

**Set it up once**

1. Find the Lantronix box's IP address on the school network and make sure the VM can
   reach it (same network, or a route/VLAN to it - Daktronics often puts its equipment on
   its own 192.168.x.x network behind a router). Its serial port must be set to 19200 baud,
   8 data bits, no parity, 1 stop bit (the Daktronics setting for All Sport data).
2. Give the box an address that doesn't change: a **DHCP reservation** for its MAC address
   (printed on the box's label) on the school's DHCP server, unless Daktronics set a fixed
   IP on the box. Otherwise the box can get another address after a power cut and the
   feed stops (over UDP, **Test connection** then lists the new address under the other
   senders).
3. Find out whether the box sends over **TCP or UDP** (below).
4. **UDP only**: allow the box's datagrams through the VM's firewall (below).
5. In the portal: **Admin → System → Daktronics scoreboard**, enter the address, **Save**,
   then **Test connection**. With the console on, it shows the clock, score and period it
   reads.
   * TCP: `10.20.1.50` (port 10001), or `10.20.1.50:3001` for another port.
   * UDP: `udp://10.20.1.50` (UDP port 21000), or `udp://10.20.1.50:21001` for another
     port: the box's IP address and the UDP port it sends to. IPv4 only, port 1024 or
     higher.
6. New games use this default scoreboard. In a game's form you can pick **another
   scoreboard** (e.g. a second gym) or turn it **off** for that game (it then neither
   reads the scoreboard nor starts or ends by itself).

Ports 30718, 30704, 9999, 14000-14009 and 80 belong to the box itself (setup, GPIO,
Telnet setup, Com Port Redirector, its web page) and never carry scoreboard data, so the
portal refuses them. Port 30718 is the trap: it accepts a connection and then sends
nothing.

**TCP or UDP?**

A Lantronix box either waits for a computer to connect to it (**TCP**, on its Channel 1
"Local Port", 10001 by default) or sends everything the console outputs as **UDP**
datagrams to one computer or to the whole subnet. Daktronics often sets it up the second
way, broadcasting to UDP port 21000, so its own Data Monitor and other PCs all get the
data. A box that refuses TCP on port 10001 ("connection refused") is usually sending over
UDP. Three ways to find out, none of which changes anything:

* **The box's web page.** From a computer on the same network, open `http://<box ip>` and
  go to **Channel 1 → Connection**. *Protocol TCP* means TCP on the Local Port shown.
  *Protocol UDP* means UDP: the *Remote Port* is the port to enter, and the *Remote
  Host/IP* is where it sends (the VM's address, a broadcast address ending in `.255`, or
  another PC). **Only look.** Clicking **Apply Settings**, even without changing anything,
  reboots the box and cuts the video board's feed - never during an event, and change
  settings only together with Daktronics.
* **tcpdump on the VM**, with the console on:
  ```bash
  sudo tcpdump -ni any -c 20 host 10.20.1.50
  ```
  It stops after 20 packets (Ctrl+C stops it sooner).
  * Lines ending in `IP 10.20.1.50.10001 > 10.20.1.255.21000: UDP, length 40`, about every
    second: the box sends over UDP. The number after the last dot of the destination is
    the port to use (`udp://10.20.1.50:21000`); the destination address before it is where
    the box sends (here the subnet's broadcast address, which reaches the VM). tcpdump
    sees packets before the firewall, so they show up here even while ufw still drops
    them.
  * The destination is `10.255.255.255`: see the netmask note below.
  * Nothing at all for half a minute: the box sends nothing the VM can see over UDP (it is
    a TCP server, or sends only to one other PC - a switch delivers that to that PC alone).
    Try TCP while tcpdump runs: `nc -v 10.20.1.50 10001`. `Flags [S.]` back from the box
    means it accepts TCP connections (and `nc` shows characters scrolling); `Flags [R.]`
    means it refuses them on that port.
* **Daktronics Data Monitor.** If a school PC (for example the video control PC) runs
  Daktronics' Data Monitor, its **Transmissions** tab shows how that PC receives the
  scoreboard data: a UDP port it listens on, or a TCP connection to the box's address and
  port.

If the box sends over UDP only to one particular PC, the VM can't receive it. Ask
Daktronics to send to the subnet's broadcast address instead (so their PC and the VM both
get it) rather than to the VM alone, which would take the data away from their PC.

**Firewall (UDP only)**

The VM's firewall (ufw, default deny incoming) silently drops the box's datagrams,
broadcasts included. Allow them from the box only, on the port it sends to:

```bash
sudo ufw allow proto udp from 10.20.1.50 to any port 21000
```

**Test connection** shows this command with your box's address and port. Re-running the
installer keeps this rule: its firewall step only ever deletes ufw rules it recorded adding
itself (as does `uninstall.sh --close-ports`). TCP needs no rule: the server connects out
to the box.

**Netmask note.** If tcpdump shows the datagrams going to `10.255.255.255`, the box's
subnet mask is the class default (255.0.0.0 for a 10.x address) instead of the network's
(usually 255.255.255.0). The VM, on a /24 network, receives those packets (tcpdump shows
them) but Linux doesn't hand them to the server. Ask Daktronics to set the box's subnet
mask to match the network, so it broadcasts to the subnet (e.g. `10.20.1.255`).

**One connection at a time (TCP).** A box that is a TCP server accepts only **one
connection at a time**. If another system already uses it (for example a Daktronics video
or graphics system), the test says "connection refused". Then either that system or the
server can read it, not both. Over UDP there's no such limit: every computer the box's
datagrams reach can read them.

**On game day**

* **Games start by themselves.** From a game's scheduled time the server watches its
  scoreboard (connects to the box, or listens for it over UDP); as soon as the console is
  on and sending, the game goes live, within about a second, and every iPhone gets its
  Live Activity, exactly as if someone had tapped **Start game**. Example: a game set for
  5:00 PM starts at 5:00 if the scoreboard is already on, or at 5:07 when the operator
  turns it on at 5:07. Nobody needs to claim it first; any scorekeeper can claim it
  afterwards for notes and **End game**. A scorekeeper (or admin) can still start a game
  by hand earlier, as before.
* It starts only within **3 hours** of its scheduled time, and never while another live
  game uses the same scoreboard - whether the scoreboard drives that game, someone scores
  it by hand, or its scoreboard was set to **Off** during the game: it starts once that
  game has ended. If two games on one scoreboard are both due, the later-scheduled one
  starts and the earlier one is skipped for good; the console then says "Won't start by
  itself" for it (start it by hand if it is played, or cancel it).
* **To keep a game from starting by itself** (for example a JV game played without the
  scoreboard, or the console on for practice at that time): in the game's form set the
  scoreboard to **Off**, or tap **Score by hand** in the scorekeeper console before the
  start. **Cancel or reschedule** a game that isn't played: otherwise it starts if the
  scoreboard is on within 3 hours of its time.
* The scorekeeper console shows what will happen, e.g. "Starts automatically at 5:00 PM
  once the scoreboard at 10.20.1.50:10001 is on." or, once its time has come, why it
  hasn't started yet.
* Once a game is live the scorekeeper console (portal and app) shows the scoreboard
  status, and the score, clock, period and undo buttons are locked: the scoreboard wins.
  Notes (Timeout, Halftime, ...) and **End game** stay with the scorekeeper.
* Right after the start (or connecting), the clock appears within a second; the score and
  period appear as soon as they change on the scoreboard or the operator stops the clock
  (the console only sends what changes). If the console still shows **the game before**
  (its final score, not reset yet), the new game takes only the clock: it stays at 0-0 in
  the first period, and the scorekeeper console says "The scoreboard still shows the game
  before ...". A **warm-up clock** shows as the game clock until the operator sets the game
  clock, and a 0:00 left over from the game before shows until the console is reset; a
  warm-up clock running out never ends the new game. Once the operator resets the console
  (new game: scores 0, period 1, in one step or several), the game takes the score and
  period from it. **Reset the console for the next game** soon after a game ends. If the
  console really shows this game (for example the game was started late), tap **Score by
  hand**, then **Use the scoreboard**: it then takes what the console shows.
* **Games end by themselves at the final horn**: basketball once the 4th quarter (or an
  overtime) runs out with the clock at 0:00 and the score not tied, volleyball once a
  team has won the match (every set, the third too, to 25 by 2, as IHSA plays it). The
  scorekeeper console shows "Final horn: the game ends by itself by 7:43 PM, 2 minutes
  after the last score change. Time put back on the clock keeps it going."; two minutes
  after the horn the game ends with that score. Free throws after the horn start the 2
  minutes again; time put back on the clock, a tie (overtime) or another period cancels
  it. If the operator starts resetting the console for the next game during those 2
  minutes (the period moved back, or a score set to 0), the game ends right away with its
  final score. Moving a won volleyball match on to the next game number adds no set. A
  game scored by hand (or without a game clock) never ends by itself: tap **End game**. A
  warm-up clock started within 2 minutes of the horn also counts as the game going on:
  end that game by hand. A volleyball match whose deciding set is played to 15 (not IHSA)
  is also ended by hand.
* So on a double-header night, a girls' game at 5:00 that ends at the horn frees the
  scoreboard, and the boys' game at 6:30 starts by itself once the console is on at 6:30
  (or right after the girls' game ends, if that is later: at 0-0 until the console is
  reset for it). A correction to the girls' final made on the console after the girls'
  game ended goes into neither game: an admin corrects the final in the portal.
* If the scoreboard is wrong or can't be reached, tap **Score by hand**: the feed pauses
  for that game and the buttons work again. **Use the scoreboard** switches back; the
  scoreboard's numbers then replace the hand-entered ones.
* If two live games point at the same scoreboard (a JV game nobody ended, then
  varsity), the game started last gets the readings; the other one switches to scoring
  by hand and stays that way, even after the newer game ends.
* If the operator resets the scoreboard for the next game before this one was ended (and
  it didn't end at the horn), the server doesn't copy the reset: after 30 seconds the game
  switches to scoring by hand with its final score intact, ready to be ended. It then no
  longer holds the scoreboard, so the next game can start by itself.
* When the game ends, the server disconnects from the box (over UDP, it stops listening),
  unless another game on that scoreboard is due to start: then it keeps watching for it.
  While it watches with the console off, it renews the TCP connection every 90 seconds;
  that is no error, and the console keeps saying it is waiting for data.

## 9. Verify APNs

```bash
sudo mchs-live-cli apns-check
```

It creates, reads back and deletes a test broadcast channel in each environment, which proves
the key, Key ID, Team ID, bundle id and broadcast capability end to end. Expected:

```
  production: OK (created and deleted test channel ...)
  sandbox: OK (created and deleted test channel ...)
```

| Error | Meaning / fix |
| ----- | ------------- |
| `FeatureNotEnabled` | Broadcast Capability not enabled for the App ID (section 4, step 1) |
| `InvalidProviderToken` | Wrong Key ID or Team ID, a revoked key, or a wrong system clock |
| `ExpiredProviderToken` | System clock is off: `timedatectl status` |
| `BadEnvironmentKeyIdInToken` | The key is limited to the other environment: use a "Sandbox & Production" key, or `--apns-environments production` |
| `TopicDisallowed` | Bundle id doesn't belong to the key's team |
| timeout / connection refused | Outbound TCP 2195/2196 (channels) or 443 to Apple is blocked |

`/api/health` shows `"apns": { "configured": true, ... }` once the key is loaded, and
the portal's admin status shows recent pushes and registered devices.

## 10. Operations

| Task | Command |
| ---- | ------- |
| Status | `systemctl status mchs-live caddy` (with a tunnel: `mchs-live mchs-live-tunnel`) |
| Server log (live) | `journalctl -u mchs-live -f` |
| Server log (today) | `journalctl -u mchs-live --since today` |
| HTTPS / certificate / access log | `journalctl -u caddy -f` (tunnel: `journalctl -u mchs-live-tunnel -f`) |
| Health | `curl -s http://127.0.0.1:8080/api/health` or `https://<domain>/api/health` |
| Restart | `sudo systemctl restart mchs-live` (viewers reconnect automatically) |
| Admin CLI | `sudo mchs-live-cli <command>` (section 6) |
| Firewall | `sudo ufw status verbose` |

**Upgrade:** get the new version and run the installer again (add `--yes` to skip the
questions). The database is backed up first (`live-...-pre-upgrade.db`).

```bash
cd ~/live-scores && git pull && sudo ./deploy/install.sh
```

(If you copied the folder instead of cloning it, copy the new one over it as in 5.1.)
Things to know:

* Your settings are kept: the installer only changes the keys it manages when you pass
  a new value (domain, APNs, time zone), and adds keys that are new in this version
  with their defaults, e.g. `SCHOOL_TIMEZONE` (`America/Chicago`, or what you enter at
  the prompt / pass with `--school-timezone`) and the capacity keys. Its output line
  `Updated /etc/mchs-live/mchs-live.env: …` lists what changed.
* The server updates the database schema by itself when it starts (now version 4:
  version 2 added the tables that let pushes survive a restart, version 3 the scoreboard
  settings of section 8.1, version 4 a game's Boys/Girls and level). An older server refuses a database
  a newer one has updated ("schema version … is newer than this server"): to go back to
  an older version, re-run its installer (it stops because the server doesn't start),
  then `sudo mchs-live-restore` the `-pre-upgrade` backup taken before the upgrade
  (changes made since are lost).
* Live games keep going: the server restarts for a few seconds and viewers reconnect.
  A push-to-start fan-out interrupted by the restart continues where it stopped, end
  broadcasts not yet delivered are retried, and every live game gets one fresh Lock
  Screen update shortly after the restart.
* With a Cloudflare Tunnel, the upgrade also installs a newer `cloudflared` if there is
  one and then restarts the tunnel: the portal is unreachable for about 5-10 seconds.
* `--admin-password` no longer exists; use `--admin-password-file` (section 5.2).
* After raising `SSE_MAX_CONNECTIONS` above about 57,000, re-run the installer (see
  Capacity below).

**Change settings:** domain, APNs key, school time zone and SSH restriction: re-run the
installer with the option, e.g. `sudo ./deploy/install.sh --apns-key-path ~/AuthKey_NEWKEY123.p8`
or `--school-timezone America/New_York` (rotating a key: install the new one, run
`apns-check`, then revoke the old key at Apple). Everything else (school name, home team
defaults, start window, capacity limits, log level): edit the file
`/etc/mchs-live/mchs-live.env`, keeping the double quotes (a `#` outside them starts a
comment), then `sudo systemctl restart mchs-live`. A value the server doesn't accept stops it with
"Invalid configuration" and the bad keys (`journalctl -u mchs-live -n 20`).

| Key | Default | Allowed values | Set by |
| --- | ------- | -------------- | ------ |
| `HOST` | `127.0.0.1` | listen address - keep loopback | installer default |
| `PORT` | `8080` | 0-65535 | installer default |
| `PUBLIC_URL` | `https://<domain>` | http(s) URL | `--domain` |
| `DATA_DIR` | `/var/lib/mchs-live` | directory of `live.db` | installer default |
| `TRUST_PROXY` | `1` | 1/0 (true/false, yes/no, on/off) | installer default |
| `SCHOOL_NAME` | `Marquette Catholic` | text | edit |
| `HOME_TEAM_NAME` | `Marquette` | at most 40 characters | edit |
| `HOME_TEAM_CODE` | `MAR` | 2-4 letters/digits | edit |
| `HOME_TEAM_COLOR` | `"#12214D"` | `#RRGGBB` (keep the quotes) | edit |
| `START_WINDOW_MINUTES` | `120` | 0-10080: scorekeepers may start a game this long before its time | edit |
| `AUTO_FINAL_HOURS` | `4` | 0.1-168: live games nobody has changed for this long are ended | edit |
| `SCHOOL_TIMEZONE` | `America/Chicago` | IANA time zone name; sent to the portal and app (`/api/config`) for game times | `--school-timezone` / prompt |
| `SSE_MAX_PER_IP` | `2000` | 1-1000000 (Capacity) | edit |
| `SSE_MAX_CONNECTIONS` | `20000` | 1-1000000 (Capacity) | edit, then re-run the installer |
| `RATE_LIMIT_PER_MINUTE` | `3000` | 1-1000000 (Capacity) | edit |
| `DEVICE_RATE_LIMIT_PER_MINUTE` | `600` | 1-1000000 (Capacity) | edit |
| `APNS_TEAM_ID` | `92KVHUHC4C` | 10 letters/digits | `--apns-team-id` |
| `APNS_KEY_ID` | (none) | 10 letters/digits | `--apns-key-id` / key file name |
| `APNS_KEY_PATH` | (none) | `/etc/mchs-live/AuthKey_<ID>.p8` | `--apns-key-path` |
| `APNS_BUNDLE_ID` | `org.marquettecatholic.app` | bundle id | `--bundle-id` |
| `APNS_ENVIRONMENTS` | `production,sandbox` | `production` and/or `sandbox` | `--apns-environments` |
| `APNS_CHANNEL_STORAGE_POLICY` | `0` | 0 = No Message Stored, 1 = Most Recent Message Stored | edit |
| `APNS_MIN_UPDATE_INTERVAL_MS` | `5000` | 0-60000: fewest ms between Lock Screen updates per game | edit |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` | edit |

Without `APNS_KEY_ID` and `APNS_KEY_PATH` (written as commented-out `#KEY=""` lines until
a key is installed) the server runs normally but sends no pushes. The full contract is in
[ARCHITECTURE.md §3](ARCHITECTURE.md#3-configuration-environment).

**Backups:** a timer copies the database every night at about 04:15 (server time;
cloud VMs usually run on UTC) to `/var/backups/mchs-live/live-YYYYmmdd-HHMMSS.db` and
deletes those unlabelled copies after 14 days. The copy is consistent even while games
are live. Backups with a label (`live-…-before-season.db`, and the `-pre-upgrade` and
`-pre-restore` copies the installer and `mchs-live-restore` make) are **never deleted
automatically**: remove them yourself when you no longer need them.

```bash
sudo mchs-live-backup                           # backup now
sudo mchs-live-backup --label before-season     # ...with a name
systemctl list-timers mchs-live-backup.timer    # next run
journalctl -u mchs-live-backup                  # backup log
```

`mchs-live-backup` options: `--dest DIR` (default `/var/backups/mchs-live`),
`--keep-days N` (delete unlabelled backups in `DIR` older than N days; `0` keeps all;
default 14), `--label TEXT` (letters, digits, `-`, `_`; at most 40), `--data-dir DIR`
(default: `DATA_DIR` from the env file), `-q`/`--quiet`, `-h`/`--help`. Each backup is
checked (`PRAGMA quick_check`) before it is kept.

Keep copies off the VM too (e.g. a nightly `rsync` of `/var/backups/mchs-live` to
the school's file server), and treat them as confidential (section 12).

**Restore:**

```bash
sudo mchs-live-restore              # pick from a list
sudo mchs-live-restore --list       # only list the backups
sudo mchs-live-restore --latest
sudo mchs-live-restore /path/to/live-20261030-041512.db   # also a gzip-compressed .db.gz
```

Add `-y`/`--yes` to skip the confirmation (needed without a terminal). It checks the file
(integrity check and the expected tables), saves the current database as `live-...-pre-restore.db`, swaps in
the backup and restarts the server; if the server doesn't come back healthy, the
previous database is put back automatically.

**Uninstall:**

```bash
sudo mchs-live-uninstall                    # or: sudo ./deploy/uninstall.sh
sudo mchs-live-uninstall --close-ports      # also remove the 80/443 firewall rules
sudo mchs-live-uninstall --purge            # also delete data, config, key, backups, user
sudo mchs-live-uninstall --remove-packages  # also remove caddy and nodejs
```

The default keeps the database, configuration and backups, so re-installing later
continues where you left off. `--purge` saves a final backup in `/root` first
(`--no-final-backup` skips it); `-y`/`--yes` skips the confirmation. SSH
firewall rules are never removed. `--remove-packages` removes only what the installer
installed: Caddy or Node.js that were already on the VM before (recorded in
`/etc/mchs-live/install.state`) stay, together with their apt repositories, and the
NodeSource repository is removed only if the installer added it. It also warns before
removing a package that other packages need.

**OS updates:** Ubuntu installs security updates automatically (unattended-upgrades;
on Debian: `sudo apt install unattended-upgrades`). The Node.js and Caddy repositories
are not included in automatic updates: run `sudo apt update && sudo apt upgrade` once
a month (or re-run the installer). Rebooting is safe; everything starts on boot.

### Capacity (big games)

The limits that protect the server are set in `/etc/mchs-live/mchs-live.env`:

| Key | Default | Limits |
| --- | ------- | ------ |
| `SSE_MAX_PER_IP` | `2000` | Open live streams (scoreboard pages, app Scores screens) per client address |
| `SSE_MAX_CONNECTIONS` | `20000` | Open live streams in total |
| `RATE_LIMIT_PER_MINUTE` | `3000` | API requests per client address per minute from visitors who are not signed in (requests with a valid admin/scorekeeper session never count) |
| `DEVICE_RATE_LIMIT_PER_MINUTE` | `600` | App device registrations (`POST /api/devices`) per client address per minute |

A client address is one IPv4 address, or one IPv6 /64 network (an IPv6 host can pick
a new address from its /64 for every request). The per-IP limits are deliberately high. At a big game, hundreds of fans in the gym
or stadium use the school Wi-Fi, and the school's firewall sends all of them to the
internet from **one public IP address** (mobile carriers do the same with carrier-grade
NAT). They all open the scoreboard at the same moment (tip-off, a close finish), and the
app on every phone registers itself when it opens. Low per-IP limits would lock most of
the crowd out with `429 Too many requests`. Every open stream keeps a connection open
in Caddy and in Node and costs memory, so the total, `SSE_MAX_CONNECTIONS`, is what
protects the VM: raise it only together with the VM's RAM. If fans report "Too many
live connections", raise `SSE_MAX_PER_IP` (or `SSE_MAX_CONNECTIONS` on a bigger VM),
then `sudo systemctl restart mchs-live`. The service may open 65,536 files; if you raise
`SSE_MAX_CONNECTIONS` above about 57,000, re-run the installer so that limit grows with it.

### Files

| Path | Contents |
| ---- | -------- |
| `/opt/mchs-live/` | Application code (replaced on upgrade) |
| `/etc/mchs-live/mchs-live.env` | Configuration (0640 root:mchslive) |
| `/etc/mchs-live/AuthKey_*.p8` | APNs key (0640 root:mchslive) |
| `/etc/mchs-live/install.state`, `ufw-rules` | What the installer set up (used by the uninstaller) |
| `/var/lib/mchs-live/live.db` | Database (plus `-wal`/`-shm` files) |
| `/var/backups/mchs-live/` | Daily backups |
| `/etc/systemd/system/mchs-live.service` | Service (local changes: `sudo systemctl edit mchs-live`) |
| `/etc/systemd/system/mchs-live-backup.{service,timer}` | Daily backup |
| `/etc/caddy/conf.d/mchs-live.caddy`, `/etc/caddy/Caddyfile` | HTTPS site; the Caddyfile imports `conf.d/*.caddy` |
| `/etc/mchs-live/cloudflare-tunnel.token`, `/etc/systemd/system/mchs-live-tunnel.service` | Cloudflare Tunnel only: the token (0600 root) and the connector service |
| `/usr/local/sbin/mchs-live-*` | `cli`, `backup`, `restore`, `uninstall` commands |

If `/etc/caddy/Caddyfile` was still the package's default, the installer replaces it
(the original is saved next to it) and manages it; if you had your own sites, it only
adds an `import` line and leaves them alone. Add other sites as separate
`/etc/caddy/conf.d/*.caddy` files.

## 11. Troubleshooting

### A Live Activity didn't appear on a phone

Work through these in order:

1. **Live Activities** is on in the app's notification settings (it is by default;
   **Sports Updates** there only controls sports notifications).
2. **Live Activities are allowed** for the app: iOS Settings → MCHS → Live Activities.
3. The phone **opened the app at least once since installing or updating it**: that
   is when the app registers its push-to-start token with the server. Open the app
   once, then start a new game.
4. The phone runs iOS 18 or newer.
5. **Right environment**: Xcode builds are sandbox, TestFlight/App Store builds are
   production, and `APNS_ENVIRONMENTS` must include it (default: both).
6. `sudo mchs-live-cli apns-check` passes (Broadcast Capability, key, team).
7. The **clock** is right on the VM: `timedatectl status` → "System clock synchronized: yes".
8. Check the server log at the time of the start: `journalctl -u mchs-live --since "10 min ago"`.
   The portal's admin status lists recent pushes and how many devices are registered
   per environment.

Updates arrive a few seconds late on purpose (at most one update every 5 s per game;
longer if Apple throttles). iOS may delay or drop updates for phones in Low Power
Mode or with "More Frequent Updates" switched off; the next update catches up. A phone that
was offline when the game started gets no Live Activity for that game, but can add it
with **Show on Lock Screen** in the app.

### No HTTPS / certificate errors

(With a Cloudflare Tunnel, see the troubleshooting list in section 5.3.)

* `journalctl -u caddy --since "1 hour ago" | grep -iE 'acme|certificate|error'`
* `dig +short <domain>` must return this VM's public IP (from outside your network too).
* TCP 80 **and** 443 must be open to the whole internet, in `ufw` **and** in any cloud
  firewall/security group (Let's Encrypt validates from many addresses).
* No other web server (apache2, nginx) may use ports 80/443: `sudo ss -ltnp '( sport = :80 or sport = :443 )'`.
* CAA records must allow `letsencrypt.org`.
* After many failed attempts Let's Encrypt rate-limits for up to an hour; Caddy
  retries on its own. Fix the cause and watch the log.

### The scoreboard doesn't update live (but reloading shows new scores)

Live updates use Server-Sent Events (`/api/stream`), a long-running HTTP response.
Caddy streams it correctly with no extra settings. If anything else sits between the
users and the VM - a load balancer, CDN, reverse proxy or a school web filter with
HTTPS inspection - it must not buffer or compress `text/event-stream` responses and
must allow idle connections of at least 60 s (the server sends a ping every 25 s).
For example, nginx needs `proxy_buffering off;` and `proxy_read_timeout 3600s;` for
`/api/stream`. A Cloudflare Tunnel (section 5.3) streams it as is, and the installer
checks this. Clients reconnect on their own after any interruption.

### The scoreboard feed doesn't update a game

The scorekeeper console shows the reason under "Scoreboard"; **Admin → System → Test
connection** gives more detail:
* *Can't reach the scoreboard ... connection refused*: the box isn't accepting TCP
  connections on that port. Most often it sends over UDP instead (find out as in section
  8.1 "TCP or UDP?", then enter `udp://<ip>:<port>`); otherwise the port is wrong (the
  data port is Channel 1's Local Port, 10001 unless it was changed) or another system
  already holds the box's one connection. *no answer*: wrong IP address, the box is off,
  or the VM can't reach that network. Test from the VM: `nc -v <ip> 10001`.
* "Port 30718 is the Lantronix box's setup port" (or 30704, 9999, 14000-14009, 80) when
  saving or testing an address: that port belongs to the box itself and never sends
  scoreboard data (30718 accepts a connection, which is why it could look connected). Use
  the data port, or `udp://` if the box sends over UDP.
* *the box closed the connection* in a test that did connect: the box (or a firewall in
  between) ended the connection before the test was done. Check the port, and whether the
  box sends over UDP instead.
* *Connected, waiting for data*: the console is off, or the Lantronix serial settings
  don't match (19200 8N1), or the cable is wrong (Daktronics: a null-modem cable from the
  console's J6 port). Random characters with `nc` mean a baud-rate mismatch.
* *Listening on UDP port ..., waiting for data from the scoreboard at ...*: nothing from
  the box gets through. Check in this order:
  1. The console is on and sending (the video board updates).
  2. The firewall: `sudo ufw status` must list the allow rule from section 8.1 for that
     address and port (**Test connection** shows the exact command).
  3. What arrives: `sudo tcpdump -ni any -c 20 host <box ip>`, then
     `sudo tcpdump -ni any -c 20 udp port <port>`. From the box to your port but not in
     the portal: the firewall (2), or they go to `10.255.255.255` (netmask note in 8.1).
     From the box to another port: enter that port. To your port from another address:
     the box's IP changed (**Test connection** lists other senders too); update the
     address and set up the DHCP reservation. Nothing from the box: check where it sends
     (Remote Host and Remote Port on its web page, look only) - it may send to one other
     PC or to another subnet.
* *Can't listen for the scoreboard on UDP port ...: another program on this server is
  using that UDP port*: `sudo ss -ulpn 'sport = :21000'` shows which program; stop it, or
  have Daktronics point the box at another port and enter that one. *the server isn't
  allowed to use that port*: a security policy on the VM keeps the service off that port;
  use another one from 1024 up.
* *The scoreboard is driving another game*: two live games point at the same scoreboard;
  end the older one.
* Not shown at all: the game isn't basketball or volleyball, Marquette isn't the home team,
  or the scoreboard is off for that game.
* The score stays at the old value after connecting: the console sends only what changes;
  it catches up at the next score or when the operator stops the clock.
* If the console's **RTD OFFSET** setting isn't 0, positions are shifted; the server
  allows for 5000/10000/15000, but 0 is safest.

### A game didn't start or end by itself

The scorekeeper console's "Scoreboard" panel says why. A game starts by itself only if it is
basketball or volleyball with Marquette at home, its scoreboard isn't **Off**, it isn't set to
**Score by hand**, its scheduled time has come (and was less than 3 hours ago), the scoreboard
is on and sending (see the previous section if it says it's waiting for data), and no other
live game uses that scoreboard - including one scored by hand someone forgot to end, or one
whose scoreboard was set to **Off** during the game: end that game, or start this one by
hand. Of two games due on one scoreboard, only the later-scheduled one starts. An admin can
always start a game by hand.

A game that started while the console still showed the game before stays at 0-0 until the
console is reset for it ("The scoreboard still shows the game before"): reset the console
(new game), or, if it does show this game, tap **Score by hand**, then **Use the scoreboard**.

A game ends by itself only while the scoreboard drives it: not when it is scored by hand,
has no game clock, or the score is tied. The basketball clock has to run out (0:00) in the
4th quarter or overtime and then stay there, with no score change, for 2 minutes; time put
back on the clock or a warm-up clock started in those 2 minutes cancels it. A volleyball
match ends 2 minutes after the winning point (every set to 25 by 2). Otherwise tap
**End game** (forgotten games end after 4 hours without changes).

### The server doesn't start

`journalctl -u mchs-live -n 50` shows the reason. "Invalid configuration" lists the
bad keys in `/etc/mchs-live/mchs-live.env` (values need double quotes; colors like
`"#12214D"` especially; `SCHOOL_TIMEZONE` must be a name from `timedatectl list-timezones`).
Caddy (or Cloudflare) answers `502` while the server is down.

### "Too many failed sign-in attempts"

Sign-in failures are counted in 15-minute windows: after 10 failures on one username,
that username is blocked **from the addresses the failures came from** (other networks
can still sign in with it), and one address (the school's public IP, for example) is
blocked after 50 failures on any usernames. Wait up to 15 minutes, or sign in from
another network (e.g. mobile data). Restarting the server
(`sudo systemctl restart mchs-live`) clears the counters.

### Locked out of SSH

Use the cloud provider's web console, then `sudo ufw allow from <your-ip> to any port 22 proto tcp`,
or re-run the installer with a corrected `--ssh-from`. The installer warns before
applying an SSH restriction that would block the session it runs in (and refuses
with `--yes`).

## 12. Security notes

* Only Caddy is reachable from the internet (80/443). With a Cloudflare Tunnel, nothing
  is: the connector only connects out. Node listens on 127.0.0.1, the firewall denies
  everything else inbound, and SSH should be limited to your admin network
  (`--ssh-from`).
* The scoreboard feed (section 8.1) only ever connects to the IP addresses an admin
  entered, only reads from them, and only while a game needs it. Only admins can set
  or test addresses; the scoreboard status is shown to signed-in staff only.
* The Cloudflare Tunnel token is a secret (`/etc/mchs-live/cloudflare-tunnel.token`,
  root only). If it leaks, move to a new tunnel as described in section 5.3 ("The token
  leaked"): refreshing the token does not disconnect a connector already running.
* The APNs key lives only in `/etc/mchs-live/` (0640 root:mchslive). Delete the copy
  you uploaded to your home directory, never commit it (`*.p8` is git-ignored), and
  revoke it in the developer portal if it leaks. No secrets are in the web portal or
  the iOS app.
* The service runs as the unprivileged `mchslive` user in a systemd sandbox: read-only
  system and code, no access to home directories, write access only to its data
  directory, no capabilities.
* Passwords are stored as scrypt hashes; sessions last 30 days and are revoked when a
  password changes. Failed sign-ins are throttled (10 per username and source, 50 per
  address, per 15 minutes) and so are wrong current passwords when changing one. Give everyone their own account, use strong passwords (12+
  characters), and disable accounts that are no longer needed.
* Backups contain password hashes and device push tokens: keep off-VM copies in
  access-controlled storage.
* HTTPS is enforced (HSTS for one year, sent by the server): don't plan to serve this
  domain over plain HTTP later. A request a proxy marks as plain HTTP
  (`X-Forwarded-Proto: http`) is redirected to HTTPS, or refused if it isn't a page view.
* Logs (journald) contain client IP addresses in Caddy's access log and in the server's
  log of changes; journald rotates them by size.
* Keep the OS patched (section 10, OS updates) and re-run the installer when a new
  version of this folder is released.

## 13. Local development

Requires Node.js 24 or newer; no `npm install` is needed (no dependencies).

```bash
cd live-scores     # or web-portal in the app project
npm start          # http://localhost:8080, database in ./data/live.db
npm test           # unit and API tests (node --test)
npm run cli -- create-user --username admin --display-name Admin --role admin
```

Configuration comes from the environment or an optional `.env` file next to
`package.json` (start from `.env.example`). To test pushes, set the `APNS_*` keys
(relative paths resolve against this folder) and use a Debug build of the app
(sandbox), launched with `-LiveScoresServerURL http://localhost:8080` in the
Simulator. The deployment scripts are in `deploy/` (`install.sh`, `uninstall.sh`,
`backup.sh`, `restore.sh`, `mchs-live-cli.sh`); check changes with
`bash -n deploy/*.sh && shellcheck -x deploy/*.sh`.
