# VoiceMa

Self-hosted voice chat for a local network — TeamSpeak/Mumble in shape, a modern
PWA in practice. One Node process serves the app and coordinates clients; the
voice itself travels **peer-to-peer** over WebRTC, so it never round-trips
through the server.

- Channels you hop between, with live occupancy and who is talking
- **Password-protected channels**, checked on the server
- Push-to-talk or voice activation, with a real noise gate and a
  **double-tap latch** for hands-free talking
- Full device control: pick any microphone and any speaker/headset
- **The microphone is only open while you are in a channel** — never before
- Installs to the home screen on Android and iOS, and to the desktop, running
  **fullscreen**
- Keeps the screen awake while you are looking at it, and **keeps audio running
  when the screen goes off**
- Text chat per channel with **system notifications** when you are away
- Dark/light themes, per-person volume

---

## Quick start

```bash
npm install
```

```bash
npm run cert
```

```bash
npm start
```

The server prints every address it is reachable at:

```
  Local      https://localhost:8443
  Ethernet   https://192.168.90.26:8443
```

Open that LAN address on any device on the same network.

### Trying it on just this machine

```bash
npm run dev
```

Runs over plain HTTP on `http://localhost:8080`. `localhost` counts as a secure
context, so the microphone and the service worker both work — but only on the
machine running the server. Phones need the HTTPS setup below.

---

## Why HTTPS is mandatory (and the one-time certificate step)

Browsers refuse microphone access and service-worker registration on any origin
that is not a *secure context*. `http://192.168.1.50` is not one. So the server
speaks HTTPS, and `npm run cert` generates:

- a small **local certificate authority** (`certs/ca.crt`)
- a **server certificate** signed by it, valid for every LAN IP and hostname
  this machine currently has

Install `ca.crt` **once per device** and everything works cleanly: no warnings,
installable PWA, background audio. Without it you can click through the warning
on desktop and voice will still work, but the PWA will not install.

Grab it from the app's sign-in screen ("Install CA certificate") or directly at
`https://<server-ip>:8443/ca.crt`.

### Installing the CA

**Windows** — double-click `ca.crt` → Install Certificate → **Local Machine** →
Place all certificates in the following store → **Trusted Root Certification
Authorities**. Restart the browser.

Or from an elevated PowerShell:

```powershell
Import-Certificate -FilePath .\certs\ca.crt -CertStoreLocation Cert:\LocalMachine\Root
```

**Android** — download the file, then Settings → Security → More security
settings → Encryption & credentials → **Install a certificate** → **CA
certificate** → pick the download. Android warns that a third party may inspect
traffic; that third party is your own server.

**iOS / iPadOS** — two steps, both required:

1. Download in Safari → Settings → **Profile Downloaded** → Install.
2. Settings → General → About → **Certificate Trust Settings** → enable full
   trust for "VoiceMa Local CA".

**macOS** — double-click → Keychain Access → System → set to **Always Trust**.

> Re-run `npm run cert` whenever the server's IP changes, then reinstall the CA.
> To cover a fixed hostname, set `VOICEMA_HOSTS=voice.office.lan` before running it.

---

## Installing the app

Once the CA is trusted:

- **Android / Chrome** — the install prompt appears on its own, or use ⋮ → *Add
  to Home screen*. Settings → App also has an **Install** button.
- **iOS / Safari** — Share → *Add to Home Screen*.
- **Desktop Chrome/Edge** — the install icon in the address bar.

Installed, it runs fullscreen — no browser chrome or address bar — and keeps
its own audio session. In a normal browser tab the app asks for fullscreen when
you join a channel; turn that off under Settings → App.

---

## Screen-off and background audio

Two different problems, handled by two different mechanisms.

**Screen stays on while you are using the app** — the Screen Wake Lock API.
Toggle it under Settings → App → *Keep screen awake*. The browser drops the lock
whenever the page is hidden, so the app re-acquires it every time you come back.

**Audio keeps flowing when the screen is off or the app is minimised** — mobile
browsers freeze background tabs, but a tab actively playing audio through a
media element is exempt. Every remote voice is mixed into one `<audio>` element
that plays permanently, and the app registers a Media Session so the OS treats
it as a media player.

What that means per platform:

| Platform | Screen off | App minimised |
| --- | --- | --- |
| Android (Chrome/Edge, installed or in-browser) | Works — call continues, shows in the notification shade | Works |
| Windows / macOS / Linux desktop | Works | Works |
| iOS / iPadOS (Safari, incl. home-screen PWA) | Usually continues briefly, then iOS suspends the app | Not reliable |

iOS is the honest exception: Apple does not let a web app hold an audio session
in the background the way a native app can. On iPhone, keep the app in the
foreground — turn *Keep screen awake* on and it will stay usable.

Lock-screen media controls are wired up: **pause mutes your microphone**, play
unmutes, stop leaves the channel. Playback itself never actually pauses, because
that would end the background session.

---

## Using it

| Action | How |
| --- | --- |
| Join a channel | Click it in the sidebar (mic permission is asked here) |
| Mute / unmute | Mic button, or **M** |
| Deafen | Sound button, or **D** — also mutes your mic |
| Push-to-talk | Settings → Voice → *Push to talk*; hold **Space** (rebindable) or the dock button on phones |
| Per-person volume | Slider on their card |
| Text chat | Speech-bubble icon in the header |
| New channel | *New channel* in the sidebar; empty user-made channels can be deleted |

### Locked channels

Give a channel a password when you create it and a padlock replaces its icon.
Anyone opening it is asked for the password, and the check happens **on the
server** — a client that skips the prompt still cannot get in, and the password
is never sent to anyone browsing the channel list.

Passwords are stored salted and hashed (`data/channels.json`), never in the
clear. A correct password is remembered on that device so you only type a room
code once; it is re-checked on every join and forgotten as soon as it stops
working. Permanent channels can carry a password too — add `"password": "…"` to
the entry in `config.json` and it is hashed at boot.

These are shared room codes for a trusted LAN, not user accounts. Anyone who
knows the code gets in, and there is no per-person identity behind it.

### Push-to-talk, and the double-tap latch

Hold the key to talk, as usual. Tap it **twice quickly** and the microphone
latches open so you can talk hands-free — the dock button turns green and
pulses, and the status reads *Push to talk · locked*. **One more tap** releases
it.

"Quickly" is the *Double-tap to lock* window in Settings → Voice, 400 ms by
default. Set it to 0 and the key behaves as plain hold-to-talk with no latching
at all. The latch also drops automatically when you mute, leave, or switch to
voice activation, so you can never walk away with an open microphone by
accident.

### Microphone privacy

The microphone is opened when you join a channel and **released the moment you
leave** — the track is stopped, so the operating system's recording indicator
goes out and other apps can use the device. Nothing is captured while you are
sitting on the channel list, and a channel whose password you get wrong never
opens the microphone at all. Playback stays alive throughout, so background
audio and the connection are unaffected.

### Chat notifications

Messages raise a system notification when you would otherwise miss them: the
window is hidden, minimised, behind another window, or the phone screen is off.
While you are actually looking at the app you get the in-app toast instead —
never both. One notification per channel, replaced as new messages arrive, and
tapping it focuses the app rather than opening a second copy.

Permission is requested the first time you join a channel, and can be turned off
under Settings → Voice → *Chat notifications*. On Android the notification is
delivered through the service worker, which is what makes it work with the
screen off.

**Voice activation** — Settings → Voice shows a live meter with a threshold
marker. Drag it just above your room noise. *Voice hold* keeps the channel open
between words so you do not get clipped.

**Audio quality** — Low (24 kbps), Normal (48 kbps) or High (96 kbps) Opus,
mono, with in-band FEC for resilience. Normal is right for almost every LAN.

---

## Configuration

`config.json`, all optional:

```json
{
  "serverName": "VoiceMa",
  "httpsPort": 8443,
  "httpRedirectPort": 8080,
  "password": "",
  "maxUsersPerChannel": 12,
  "allowUserChannels": true,
  "channels": [
    { "id": "general", "name": "General", "description": "Everyone lands here" },
    { "id": "finance", "name": "Finance", "password": "a-shared-code" }
  ]
}
```

Channels listed here are permanent and cannot be deleted from the UI. Channels
people create at runtime live in `data/channels.json`.

Environment overrides: `VOICEMA_NAME`, `VOICEMA_PORT`, `VOICEMA_HTTP_PORT`,
`VOICEMA_PASSWORD`, `VOICEMA_HOSTS`.

Setting a `password` makes the sign-in screen ask for it. It is a shared-secret
speed bump for a trusted office LAN, not real authentication — there are no user
accounts.

---

## Running it as a service on Windows

Allow the port through the firewall once (elevated PowerShell):

```powershell
New-NetFirewallRule -DisplayName "VoiceMa" -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow
```

To keep it running after logout, install it as a service with
[NSSM](https://nssm.cc/):

```powershell
nssm install VoiceMa "C:\Program Files\nodejs\node.exe" "D:\Development\VoiceMa\server\index.js"
```

Set the working directory to the project folder, then `nssm start VoiceMa`.

---

## How it fits together

```
             ┌──────────────┐
   HTTPS ──▶ │  Node server │ ◀── WebSocket signalling (SDP, ICE, roster, chat)
   static    └──────────────┘
                   ▲  ▲
                   │  │   never carries voice
        ┌──────────┘  └───────────┐
   ┌────────┐                ┌────────┐
   │ Client │ ◀── WebRTC ──▶ │ Client │   Opus audio, direct, encrypted (DTLS-SRTP)
   └────────┘   full mesh    └────────┘
```

Everyone in a channel holds one peer connection to everyone else. On a LAN that
is the lowest-latency arrangement available — typically 1–5 ms — and the server
stays idle. Upstream cost is `(n-1) x ~50 kbps`, so a 10-person channel uses
about 450 kbps up: nothing on wired or modern Wi-Fi. Beyond ~12 people per
channel a selective forwarding unit would be the better shape; the per-channel
limit exists for that reason.

No STUN or TURN servers are configured, and none are needed — LAN peers reach
each other on host candidates.

**Layout**

```
server/    signaling.js  channel + roster state, message relay
           static.js     static files, CA download
           index.js      HTTPS/HTTP wiring, boot banner
public/js/ audio.js      capture, gate, mixing bus, device routing
           rtc.js        mesh peer connections, Opus tuning, stats
           net.js        WebSocket client with reconnect
           keepalive.js  wake lock, Media Session, background audio
           vad-processor.js  noise gate, runs on the audio thread
scripts/   gen-cert.js   local CA + LAN certificate
           gen-icons.js  PNG icon set, no image dependencies
           test-signaling.js  protocol test against a live server
```

The noise gate runs in an **AudioWorklet** rather than on a timer specifically
so voice activation keeps working when the phone screen is off — timers are
throttled in background tabs, the audio thread is not.

---

## Troubleshooting

**"Microphone permission was denied"** — the browser blocked it. Check the site
permissions, and confirm you are on `https://` or `localhost`.

**Phone will not install the app** — the CA is not trusted yet. Any certificate
warning blocks service-worker registration, which blocks installation.

**Cannot choose an output device** — `setSinkId` is not available in every
mobile browser. Audio then follows the system default, which still means it
moves to earbuds or a Bluetooth headset when you connect them. Settings → App
shows what your browser supports.

**Someone joins but nobody hears them** — open Settings → App and look at
*Connection*. In the browser console, `voicema.mesh.summary()` reports the state
and round-trip time of every peer connection. Client isolation (AP isolation /
guest Wi-Fi) blocks peer-to-peer traffic and is the usual culprit.

**Echo** — someone is on open speakers with echo cancellation off. Turn it back
on in Settings → Audio.

**Nothing happens after the server IP changes** — regenerate the certificate
(`npm run cert`) and reinstall the CA.

---

## Testing

```bash
npm test
```

Drives two real clients through the live server: join, roster, SDP relay,
speaking state, chat, cross-channel isolation, history backfill, channel
lifecycle, input sanitising, and disconnect cleanup.
