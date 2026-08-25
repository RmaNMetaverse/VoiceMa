# Deploying VoiceMa on Ubuntu

How to put VoiceMa on a fresh Ubuntu (or Debian) server as an always-running
service, reachable at a sub-path such as **`https://192.168.90.5/VoiceMa`**, on
a machine you intend to fill with other applications too.

---

## The short version

On the server:

```bash
git clone https://github.com/RmaNMetaverse/VoiceMa.git && cd VoiceMa && sudo bash install.sh
```

Answer four questions (mount path, port, display name, address), and it is done.
Then [install the CA certificate](#step-2--trust-the-certificate-once-per-device)
on every device that will use it.

Everything below explains what that script does and how to run the result.

---

## Why there is a reverse proxy

You asked for `https://192.168.90.5/VoiceMa` with room for other apps beside it.
Only one process can own port 443, so something has to sit in front and hand
each path to the right application. That is what nginx does here, and the
installer sets it up for you — the server does not need one beforehand.

```
                    ┌──────────────── nginx :443 (TLS) ────────────────┐
  browser ────────▶ │  /VoiceMa/  ──▶  127.0.0.1:8471   (this app)     │
  https://…/VoiceMa │  /grafana/  ──▶  127.0.0.1:3000   (whatever next)│
                    └──────────────────────────────────────────────────┘
```

The app itself listens on **loopback only**. Nothing but nginx can reach it, and
the app is aware of its own mount point, so links, the manifest, the service
worker and the WebSocket all resolve under `/VoiceMa/` rather than `/`.

Voice audio does **not** go through nginx. Once two people are in a channel their
browsers talk peer-to-peer over WebRTC; nginx only carries the signalling
WebSocket and the static files.

---

## Step 1 — run the installer

```bash
sudo bash install.sh
```

(`sudo ./install.sh` works too once the file is executable — `chmod +x install.sh`.
Invoking it through `bash` avoids depending on the mode bit surviving the clone.)

It asks:

| Question | Default | Notes |
| --- | --- | --- |
| Mount the app under which path? | `/VoiceMa` | One path segment. This is the `/VoiceMa` in the URL. |
| Internal port | `8471` | Loopback only. Auto-advances if busy. |
| Display name | `VoiceMa` | Shown in the app header. |
| Address people will type | detected IP | Goes into the certificate — get this right. |
| Optional server password | none | A shared code to enter the server at all. |

Non-interactive, for a scripted build:

```bash
sudo bash install.sh --path /VoiceMa --port 8471 --name "Ops Voice" --hosts 192.168.90.5 --yes
```

What it installs:

- **Node.js 20** (skipped if the system already has 18+)
- **nginx**, plus a shared TLS server block and a location block for this app
- **`/opt/voicema`** — the app, owned by root; only `data/` is writable by the service
- **a `voicema` system user** with no login shell
- **`voicema.service`** — systemd, `Restart=always`, starts at boot
- **a local CA and certificate** in `/opt/voicema/certs`, covering the address you gave

The script is safe to re-run: it pulls the latest code, rewrites the config and
restarts. That is also how you update.

---

## Step 2 — trust the certificate (once per device)

`192.168.90.5` is a private address, so no public authority will ever issue a
certificate for it. The installer generates its own CA instead.

This is not cosmetic. Until the CA is trusted, the browser treats the origin as
insecure and **blocks the service worker**, which means the app cannot be
installed to a home screen, and background behaviour suffers.

Download it from **`https://192.168.90.5/VoiceMa/ca.crt`** (also linked on the
sign-in screen), then:

**Windows** — double-click → Install Certificate → **Local Machine** → *Place all
certificates in the following store* → **Trusted Root Certification Authorities**.
Restart the browser.

**Android** — Settings → Security → More security settings → Encryption &
credentials → **Install a certificate** → **CA certificate** → pick the download.
Android warns that a third party could inspect traffic; that third party is your
own server.

**iOS / iPadOS** — two steps, both needed:
1. Download in Safari → Settings → **Profile Downloaded** → Install.
2. Settings → General → About → **Certificate Trust Settings** → turn on full
   trust for *VoiceMa Local CA*.

**macOS** — double-click → Keychain Access → System → **Always Trust**.

**Linux** —
```bash
sudo cp voicema-ca.crt /usr/local/share/ca-certificates/voicema.crt && sudo update-ca-certificates
```
Firefox keeps its own store: Settings → Privacy & Security → Certificates → Import.

---

## Step 3 — use it

Open `https://192.168.90.5/VoiceMa` and pick a channel. On phones, install it to
the home screen for fullscreen and reliable background audio.

---

## Running it

```bash
systemctl status voicema      # is it up
journalctl -u voicema -f      # live logs
systemctl restart voicema     # restart
systemctl stop voicema        # stop
```

Update to the latest code:

```bash
sudo bash /opt/voicema/install.sh --yes
```

Remove the service and the nginx entry (leaves the files and data alone):

```bash
sudo bash /opt/voicema/install.sh --uninstall
```

---

## Adding your other applications

The installer writes a shared server block at
`/etc/nginx/sites-available/lan-apps` that includes every file in
`/etc/nginx/lan-apps.d/`. To add another app, drop in one file:

```nginx
# /etc/nginx/lan-apps.d/grafana.conf
location = /grafana { return 301 /grafana/; }

location /grafana/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Two things to copy from the VoiceMa block:

- **`proxy_pass` has no path after the port.** That forwards the original URI
  unchanged, including `/grafana`. Adding a trailing `/` would strip the prefix,
  and an app that expects to know its own mount point would then generate broken
  links.
- **`$connection_upgrade`** comes from the map in
  `/etc/nginx/conf.d/websocket-upgrade.conf`, written once by the installer.
  Without it, WebSockets fail while ordinary pages appear fine.

Not every app can live under a sub-path — it has to build its URLs relative to a
base. VoiceMa does; if another one does not, give it its own hostname or port
instead of fighting it.

The shared block also serves a small index at `/` listing VoiceMa. Edit it
freely; the installer will not overwrite it once it exists.

---

## What the installer configures

`/opt/voicema/config.json`:

```json
{
  "serverName": "VoiceMa",
  "httpsPort": 8471,
  "httpRedirectPort": 0,
  "bindAddress": "127.0.0.1",
  "basePath": "/VoiceMa",
  "password": "",
  "maxUsersPerChannel": 12,
  "allowUserChannels": true,
  "channels": [
    { "id": "general", "name": "General", "description": "Everyone lands here" }
  ]
}
```

- `bindAddress: 127.0.0.1` — unreachable except through nginx.
- `basePath` — the mount point. The server strips it from incoming requests and
  injects a matching `<base>` tag, so the client resolves everything relative to it.
- `httpRedirectPort: 0` — off; nginx owns port 80.
- Add channels here to make them permanent (they cannot be deleted from the UI).
  Give one a `"password"` and it is hashed at startup.

Edit and then `sudo systemctl restart voicema`. Re-running the installer
rewrites this file, so keep bigger changes in a copy.

Runtime state lives in `/opt/voicema/data/channels.json` — channels people
create themselves. It survives updates.

---

## Troubleshooting

**502 Bad Gateway** — the app is not running behind the proxy.
```bash
systemctl status voicema
journalctl -u voicema -n 50 --no-pager
curl -s http://127.0.0.1:8471/VoiceMa/health
```

**The page loads but never connects** — the WebSocket is being dropped. Confirm
the upgrade map exists and the location block sends the two upgrade headers:
```bash
ls /etc/nginx/conf.d/websocket-upgrade.conf
nginx -T | grep -A3 connection_upgrade
```

**Certificate warning that will not go away** — the CA is not trusted on that
device yet, or the certificate does not cover the address being typed. If the
server's IP changed:
```bash
sudo rm -rf /opt/voicema/certs && sudo bash /opt/voicema/install.sh --yes
```
and reinstall the CA on each device — it is a new CA.

**Cannot install to the home screen** — always the certificate. Any warning
blocks the service worker, and no service worker means no install.

**Microphone permission never appears** — the page must be on `https://`. Check
that http→https redirect is working, and that you are not on the raw
`http://192.168.90.5:8471`.

**Everyone connects but nobody hears anyone** — peer-to-peer traffic is being
blocked between clients, not by the server. Wi-Fi client isolation (AP isolation
/ guest networks) is the usual cause. In the browser console,
`voicema.mesh.summary()` shows each peer connection's state.

**Port already in use during install** — pass another with `--port 8472`.

---

## Notes on security

This is built for a **trusted LAN**. There are no user accounts: a display name
is whatever someone types, the optional server password and channel passwords
are shared codes, and anyone who can reach the address can join.

The parts that are real: the app runs as an unprivileged user under a hardened
systemd unit that can only write its own data directory; it is not reachable
except through nginx; channel passwords are salted and hashed, never sent to
clients; and WebRTC media is encrypted (DTLS-SRTP) between peers regardless.

Do not expose this to the internet as-is. If you need that, put real
authentication in front of it and use a certificate from a public authority.
