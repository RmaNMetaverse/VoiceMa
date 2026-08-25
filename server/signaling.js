import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { config, ROOT } from './config.js';

const DATA_DIR = path.join(ROOT, 'data');
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');

const CHAT_HISTORY = 60; // messages kept per channel, in memory + on disk-less restart
const HEARTBEAT_MS = 15000;
const MAX_MSG_BYTES = 64 * 1024; // an SDP blob is a few KB; anything larger is abuse
const MAX_NAME = 24;
const MAX_CHAT = 800;

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24) || 'channel';

/**
 * Channel passwords are stored salted and hashed, never in the clear, and are
 * never included in anything sent to a client.
 *
 * SHA-256 rather than a slow KDF is a deliberate, proportionate choice: these
 * are shared room codes on a trusted LAN, not user account credentials. Do not
 * reuse this helper for anything that guards a real identity.
 */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
  return { salt, hash };
}

function verifyPassword(channel, password) {
  if (!channel?.hash) return true; // open channel
  if (typeof password !== 'string' || !password) return false;
  const candidate = Buffer.from(hashPassword(password, channel.salt).hash, 'hex');
  const expected = Buffer.from(channel.hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

const clean = (s, max) =>
  String(s ?? '')
    // Strip control characters so nothing can smuggle terminal escapes into logs.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);

export class Hub {
  constructor(server) {
    /** @type {Map<string, any>} id -> user record (ws lives on user.ws) */
    this.users = new Map();
    this.channels = this.loadChannels();
    this.chat = new Map(); // channelId -> message[]

    this.wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MSG_BYTES });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));

    // ws re-emits the HTTP server's errors here. Without a listener, a plain
    // listen failure (EADDRINUSE) becomes an unhandled 'error' event and the
    // process dies with a stack trace instead of the message in index.js.
    this.wss.on('error', (err) => {
      if (err?.code === 'EADDRINUSE') return; // index.js reports this properly
      console.warn('hub: websocket server error —', err?.message ?? err);
    });

    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  // ---------- channels ----------

  loadChannels() {
    const base = (config.channels ?? []).map((c) => ({
      id: c.id ?? slug(c.name),
      name: clean(c.name, MAX_NAME) || 'Channel',
      description: clean(c.description ?? '', 60),
      limit: Number(c.limit ?? config.maxUsersPerChannel),
      permanent: true,
      // A plaintext password in config.json is hashed at boot and never kept.
      ...(c.password ? hashPassword(String(c.password)) : {})
    }));

    let saved = [];
    try {
      saved = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
    } catch {
      /* first run */
    }

    const byId = new Map(base.map((c) => [c.id, c]));
    for (const c of Array.isArray(saved) ? saved : []) {
      if (!c?.id || byId.has(c.id)) continue;
      byId.set(c.id, {
        id: c.id,
        name: clean(c.name, MAX_NAME) || 'Channel',
        description: clean(c.description ?? '', 60),
        limit: Number(c.limit ?? config.maxUsersPerChannel),
        permanent: false,
        // Persisted channels keep the salt+hash they were created with.
        ...(c.hash && c.salt ? { hash: c.hash, salt: c.salt } : {})
      });
    }
    return [...byId.values()];
  }

  saveChannels() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(
        CHANNELS_FILE,
        JSON.stringify(
          this.channels.filter((c) => !c.permanent),
          null,
          2
        )
      );
    } catch (err) {
      console.warn('hub: could not persist channels —', err.message);
    }
  }

  channel(id) {
    return this.channels.find((c) => c.id === id);
  }

  occupancy(id) {
    let n = 0;
    for (const u of this.users.values()) if (u.channel === id) n++;
    return n;
  }

  // ---------- wire helpers ----------

  send(ws, msg) {
    if (ws?.readyState === ws?.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        /* socket died mid-write */
      }
    }
  }

  broadcast(msg, filter) {
    const raw = JSON.stringify(msg);
    for (const u of this.users.values()) {
      if (filter && !filter(u)) continue;
      if (u.ws.readyState === u.ws.OPEN) {
        try {
          u.ws.send(raw);
        } catch {
          /* ignore */
        }
      }
    }
  }

  publicUser(u) {
    return {
      id: u.id,
      name: u.name,
      hue: u.hue,
      channel: u.channel,
      mic: u.mic,
      deaf: u.deaf,
      speaking: u.speaking,
      since: u.since
    };
  }

  roster() {
    return [...this.users.values()].map((u) => this.publicUser(u));
  }

  /** Public view of a channel: `locked` is a flag, the salt and hash never leave. */
  channelList() {
    return this.channels.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      limit: c.limit,
      permanent: c.permanent,
      locked: !!c.hash,
      count: this.occupancy(c.id)
    }));
  }

  /** One snapshot message keeps every client's view consistent — cheap at LAN scale. */
  pushRoster() {
    this.broadcast({ t: 'roster', users: this.roster(), channels: this.channelList() });
  }

  // ---------- connection lifecycle ----------

  onConnection(ws, req) {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    let user = null;
    let bucket = { tokens: 60, at: Date.now() };

    const rateLimited = () => {
      const now = Date.now();
      bucket.tokens = Math.min(60, bucket.tokens + ((now - bucket.at) / 1000) * 30);
      bucket.at = now;
      if (bucket.tokens < 1) return true;
      bucket.tokens -= 1;
      return false;
    };

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (typeof msg?.t !== 'string') return;

      // Signalling traffic is bursty by nature, so it bypasses the token bucket.
      if (msg.t !== 'signal' && msg.t !== 'ping' && rateLimited()) return;

      if (!user) {
        if (msg.t !== 'hello') return;
        user = this.handleHello(ws, msg, ip);
        return;
      }
      this.handleMessage(user, msg);
    });

    const drop = () => {
      if (!user) return;
      this.users.delete(user.id);
      console.log(`hub: ${user.name} left (${this.users.size} online)`);
      this.pushRoster();
      user = null;
    };

    ws.on('close', drop);
    ws.on('error', drop);
  }

  handleHello(ws, msg, ip) {
    if (config.password && msg.password !== config.password) {
      this.send(ws, { t: 'denied', reason: 'Wrong server password.' });
      setTimeout(() => ws.close(4003, 'unauthorised'), 50);
      return null;
    }

    const id = crypto.randomUUID();
    const name = clean(msg.name, MAX_NAME) || `Guest-${id.slice(0, 4)}`;
    const user = {
      id,
      ws,
      ip,
      name,
      hue: Number.isFinite(msg.hue) ? ((msg.hue % 360) + 360) % 360 : Math.floor(Math.random() * 360),
      channel: null,
      mic: 'muted',
      deaf: false,
      speaking: false,
      since: Date.now()
    };
    this.users.set(id, user);

    this.send(ws, {
      t: 'welcome',
      self: this.publicUser(user),
      server: {
        name: config.serverName,
        allowUserChannels: config.allowUserChannels !== false,
        maxUsersPerChannel: config.maxUsersPerChannel
      },
      users: this.roster(),
      channels: this.channelList()
    });

    console.log(`hub: ${name} joined from ${ip} (${this.users.size} online)`);
    this.pushRoster();
    return user;
  }

  handleMessage(user, msg) {
    switch (msg.t) {
      case 'ping':
        this.send(user.ws, { t: 'pong', ts: msg.ts });
        break;

      case 'join':
        this.joinChannel(user, msg.channel, msg.password);
        break;

      case 'leave':
        if (user.channel) {
          user.channel = null;
          user.speaking = false;
          this.pushRoster();
        }
        break;

      case 'state': {
        // Speaking flips often; only a real change is worth a broadcast.
        const mic = ['muted', 'open', 'ptt'].includes(msg.mic) ? msg.mic : user.mic;
        const deaf = !!msg.deaf;
        const speaking = !!msg.speaking && mic !== 'muted';
        if (mic === user.mic && deaf === user.deaf && speaking === user.speaking) break;
        user.mic = mic;
        user.deaf = deaf;
        user.speaking = speaking;
        this.broadcast({
          t: 'user-state',
          id: user.id,
          mic,
          deaf,
          speaking
        });
        break;
      }

      case 'rename': {
        const name = clean(msg.name, MAX_NAME);
        if (!name || name === user.name) break;
        user.name = name;
        this.pushRoster();
        break;
      }

      case 'signal': {
        // Pure relay. Peers only ever exchange SDP/ICE, never anything the
        // server interprets, and only inside a shared channel.
        const peer = this.users.get(msg.to);
        if (!peer || !user.channel || peer.channel !== user.channel) break;
        this.send(peer.ws, { t: 'signal', from: user.id, payload: msg.payload });
        break;
      }

      case 'chat': {
        const text = clean(msg.text, MAX_CHAT);
        if (!text || !user.channel) break;
        const entry = {
          id: crypto.randomUUID(),
          from: user.id,
          name: user.name,
          hue: user.hue,
          channel: user.channel,
          text,
          ts: Date.now()
        };
        const log = this.chat.get(user.channel) ?? [];
        log.push(entry);
        if (log.length > CHAT_HISTORY) log.splice(0, log.length - CHAT_HISTORY);
        this.chat.set(user.channel, log);
        this.broadcast({ t: 'chat', message: entry }, (u) => u.channel === user.channel);
        break;
      }

      case 'channel:create': {
        if (config.allowUserChannels === false) break;
        const name = clean(msg.name, MAX_NAME);
        if (!name) break;
        let id = slug(name);
        let n = 2;
        while (this.channel(id)) id = `${slug(name)}-${n++}`;
        const password = typeof msg.password === 'string' ? msg.password.slice(0, 64) : '';
        this.channels.push({
          id,
          name,
          description: clean(msg.description ?? '', 60),
          limit: config.maxUsersPerChannel,
          permanent: false,
          createdBy: user.id,
          ...(password ? hashPassword(password) : {})
        });
        this.saveChannels();
        this.pushRoster();
        // The creator gets in without being asked for what they just set.
        this.send(user.ws, { t: 'channel:created', id, locked: !!password });
        break;
      }

      case 'channel:delete': {
        const ch = this.channel(msg.id);
        if (!ch || ch.permanent) break;
        if (this.occupancy(ch.id) > 0) {
          this.send(user.ws, { t: 'notice', text: 'Channel is not empty.' });
          break;
        }
        this.channels = this.channels.filter((c) => c.id !== ch.id);
        this.chat.delete(ch.id);
        this.saveChannels();
        this.pushRoster();
        break;
      }
    }
  }

  joinChannel(user, channelId, password) {
    const ch = this.channel(channelId);
    if (!ch) {
      this.send(user.ws, { t: 'notice', text: 'That channel no longer exists.' });
      return;
    }
    if (user.channel === ch.id) return;

    const limit = ch.limit || config.maxUsersPerChannel;
    if (this.occupancy(ch.id) >= limit) {
      this.send(user.ws, { t: 'notice', text: `${ch.name} is full (${limit}).` });
      return;
    }

    // Locked channels are checked here, on the server. A client that hides the
    // prompt still cannot get in.
    if (!verifyPassword(ch, password)) {
      this.send(user.ws, {
        t: 'join:denied',
        channel: ch.id,
        name: ch.name,
        reason: password ? 'That password is not right.' : 'This channel needs a password.'
      });
      return;
    }

    user.channel = ch.id;
    user.speaking = false;
    this.pushRoster();

    // Backfill recent chat so a joiner sees the conversation in progress.
    const log = this.chat.get(ch.id) ?? [];
    if (log.length) this.send(user.ws, { t: 'chat:history', channel: ch.id, messages: log });
  }

  sweep() {
    for (const u of [...this.users.values()]) {
      if (u.ws.isAlive === false) {
        u.ws.terminate();
        continue;
      }
      u.ws.isAlive = false;
      try {
        u.ws.ping();
      } catch {
        /* ignore */
      }
    }
  }

  close() {
    clearInterval(this.heartbeat);
    this.wss.close();
  }
}
