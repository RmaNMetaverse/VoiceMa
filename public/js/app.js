import { settings, set, save, peerVolume, channelPassword, QUALITY } from './store.js';
import { AudioEngine } from './audio.js';
import { Net } from './net.js';
import { Mesh } from './rtc.js';
import { Keepalive } from './keepalive.js';
import {
  $,
  toast,
  renderChannels,
  Participants,
  appendMessage,
  systemMessage,
  clearChat,
  initials
} from './ui.js';

/* ============================================================
   State
   ============================================================ */

const state = {
  users: [],
  channels: [],
  self: null,
  channel: null,
  server: { name: 'VoiceMa', allowUserChannels: true },
  micEnabled: false,
  deafened: false,
  micBeforeDeafen: false,
  stats: {},
  bindingKey: false,
  pendingJoin: null,
  joinTarget: null,
  lastCreatedPassword: ''
};

const audio = new AudioEngine();
const net = new Net();
const mesh = new Mesh(net, audio);
const keepalive = new Keepalive(audio);
const participants = new Participants($('participants'), {
  onVolume: (id, v) => {
    audio.setPeerVolume(id, v);
    const user = state.users.find((u) => u.id === id);
    if (user) peerVolume(user.name, v);
  }
});

const isSelf = (u) => u.id === net.selfId;

/** Members of the channel we are in. Empty in the lobby — without the guard,
 *  `u.channel === null` would match every other idle user and we would open
 *  peer connections to people who have not joined anything. */
const inChannel = () =>
  state.channel ? state.users.filter((u) => u.channel === state.channel) : [];

/* ============================================================
   Theme + chrome
   ============================================================ */

function applyTheme(theme) {
  set({ theme });
  document.documentElement.dataset.theme = theme;
  const dark =
    theme === 'dark' ||
    (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.remove();
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = dark ? '#0b0b12' : '#f4f4fb';
  document.head.appendChild(meta);

  for (const btn of $('seg-theme').children) {
    btn.classList.toggle('is-active', btn.dataset.theme === theme);
  }
}

/** Pointer-tracked specular highlight on every glass surface. */
function wireSheen() {
  if (!matchMedia('(hover: hover)').matches) return;
  document.addEventListener(
    'pointermove',
    (e) => {
      const surface = e.target.closest?.('[data-sheen]');
      if (!surface) return;
      const r = surface.getBoundingClientRect();
      surface.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
      surface.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
    },
    { passive: true }
  );
}

/* ============================================================
   Sign-in gate
   ============================================================ */

const HUES = [255, 210, 175, 145, 45, 25, 350, 310];

function buildGate() {
  const host = $('hue-swatches');
  if (settings.hue == null) settings.hue = HUES[Math.floor(Math.random() * HUES.length)];

  for (const hue of HUES) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'hue-dot';
    dot.style.background = `linear-gradient(145deg, hsl(${hue} 82% 64%), hsl(${hue + 40} 78% 52%))`;
    dot.setAttribute('role', 'radio');
    dot.setAttribute('aria-checked', String(hue === settings.hue));
    dot.setAttribute('aria-label', `Colour ${hue}`);
    dot.addEventListener('click', () => {
      set({ hue });
      for (const d of host.children) d.setAttribute('aria-checked', String(d === dot));
    });
    host.appendChild(dot);
  }

  $('gate-name').value = settings.name || '';

  fetch(new URL('api/info', document.baseURI))
    .then((r) => r.json())
    .then((info) => {
      state.server = { ...state.server, ...info };
      $('gate-server').textContent = info.name;
      $('server-name').textContent = info.name;
      document.title = info.name;
      $('gate-password-field').hidden = !info.requiresPassword;
    })
    .catch(() => {});

  $('gate-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('gate-name').value.trim();
    if (!name) return;
    set({ name });
    $('gate-error').textContent = '';
    $('gate-submit').disabled = true;

    // The submit click is our user gesture: unlock audio playback here so the
    // browser lets the bus element run for the rest of the session.
    audio.ensureContext().catch(() => {});

    net.connect({ name, hue: settings.hue, password: $('gate-password').value || undefined });
  });
}

function enterApp() {
  $('gate').hidden = true;
  $('app').hidden = false;
  $('self-name').textContent = settings.name;
  $('self-avatar').textContent = initials(settings.name);
  $('self-avatar').style.setProperty('--hue', settings.hue);
  $('set-name').value = settings.name;
  refreshDevices();
}

/* ============================================================
   Networking
   ============================================================ */

net.addEventListener('state', () => {
  const badge = $('conn-status');
  const map = {
    connecting: ['connecting…', 'status-connecting'],
    online: ['connected', 'status-online'],
    offline: ['reconnecting…', 'status-offline'],
    idle: ['offline', 'status-offline']
  };
  const [text, cls] = map[net.state] ?? map.idle;
  badge.textContent = text;
  badge.className = `status ${cls}`;
  updateDiagnostics();
});

net.addEventListener('welcome', ({ detail }) => {
  const first = $('app').hidden;
  state.server = { ...state.server, ...detail.server };
  $('server-name').textContent = detail.server.name;
  $('gate-submit').disabled = false;

  if (first) enterApp();

  // A reconnect hands us a brand new id, so every peer connection is stale.
  mesh.closeAll();
  applyRoster(detail.users, detail.channels);

  // Rejoin whatever channel we were in before the drop, password and all.
  if (state.channel) {
    net.send({
      t: 'join',
      channel: state.channel,
      password: channelPassword(state.channel) || undefined
    });
  }
});

net.addEventListener('denied', ({ detail }) => {
  $('gate-submit').disabled = false;
  $('gate-error').textContent = detail.reason ?? 'Connection refused.';
});

net.addEventListener('roster', ({ detail }) => applyRoster(detail.users, detail.channels));

net.addEventListener('user-state', ({ detail }) => {
  const user = state.users.find((u) => u.id === detail.id);
  if (!user) return;
  Object.assign(user, { mic: detail.mic, deaf: detail.deaf, speaking: detail.speaking });
  participants.sync(inChannel(), net.selfId, volumeFor);
  scheduleChannelRender();
});

net.addEventListener('signal', ({ detail }) => mesh.handleSignal(detail.from, detail.payload));

net.addEventListener('chat', ({ detail }) => {
  appendMessage(detail.message, net.selfId);
  if ($('chat').hidden && detail.message.from !== net.selfId) {
    $('toggle-chat').classList.add('has-unread');
    if (document.visibilityState === 'visible') {
      toast(`${detail.message.name}: ${detail.message.text.slice(0, 60)}`);
    }
  }
  notifyChat(detail.message);
});

net.addEventListener('chat:history', ({ detail }) => {
  clearChat();
  for (const m of detail.messages) appendMessage(m, net.selfId);
});

net.addEventListener('notice', ({ detail }) => toast(detail.text, 'bad'));

net.addEventListener('join:denied', ({ detail }) => {
  // A remembered password that no longer works must not be retried forever.
  channelPassword(detail.channel, null);
  state.pendingJoin = null;

  const channel = state.channels.find((c) => c.id === detail.channel);
  openJoinDialog(channel ?? { id: detail.channel, name: detail.name }, detail.reason);

  // We opened the microphone in anticipation of joining; give it back.
  if (!state.channel && audio.started) {
    setMicEnabled(false);
    audio.stopCapture();
    refreshDevices();
  }
});

net.addEventListener('channel:created', ({ detail }) => {
  // The creator already knows the password — reuse what they just typed.
  joinChannel(detail.id, state.lastCreatedPassword || undefined);
  state.lastCreatedPassword = '';
});
net.addEventListener('latency', () => {
  $('stat-ping').textContent = net.latency == null ? '— ms' : `${net.latency} ms`;
});

/** Applies a roster snapshot: diff for chimes, re-sync the mesh, repaint. */
function applyRoster(users, channels) {
  const previous = new Map(state.users.map((u) => [u.id, u]));
  const wasInChannel = new Set(
    state.users.filter((u) => u.channel === state.channel).map((u) => u.id)
  );

  state.users = users;
  state.channels = channels;
  state.self = users.find((u) => u.id === net.selfId) ?? null;

  const previousChannel = state.channel;
  state.channel = state.self?.channel ?? null;

  if (state.channel !== previousChannel) {
    if (state.channel) onJoined(state.channel);
    else if (audio.started) {
      // Moved out of every channel (kicked, channel deleted, forced leave).
      releasePTTLatch();
      setMicEnabled(false);
      keepalive.setActive(false);
      audio.stopCapture();
    }
  }

  const members = inChannel();

  // Join / leave chimes, but only for other people and only once we are settled.
  if (settings.sounds && state.channel && previousChannel === state.channel) {
    for (const u of members) {
      if (!isSelf(u) && !wasInChannel.has(u.id)) {
        audio.chime(true);
        systemMessage(`${u.name} joined`);
        break;
      }
    }
    for (const id of wasInChannel) {
      if (!members.some((u) => u.id === id) && id !== net.selfId) {
        const gone = previous.get(id);
        audio.chime(false);
        if (gone) systemMessage(`${gone.name} left`);
        break;
      }
    }
  }

  mesh.sync(members.filter((u) => !isSelf(u)).map((u) => u.id));

  // Restore any remembered per-person volume for newly connected peers.
  for (const u of members) {
    if (isSelf(u)) continue;
    audio.setPeerVolume(u.id, peerVolume(u.name));
  }

  renderAll();
}

function volumeFor(user) {
  return peerVolume(user.name);
}

/* ============================================================
   Rendering
   ============================================================ */

let channelRenderQueued = false;
function scheduleChannelRender() {
  if (channelRenderQueued) return;
  channelRenderQueued = true;
  setTimeout(() => {
    channelRenderQueued = false;
    renderChannelList();
  }, 120);
}

function renderChannelList() {
  renderChannels({
    channels: state.channels,
    users: state.users,
    currentId: state.channel,
    selfId: net.selfId,
    onJoin: joinChannel,
    onDelete: (id) => net.send({ t: 'channel:delete', id })
  });
}

function renderAll() {
  renderChannelList();

  const members = inChannel();
  const channel = state.channels.find((c) => c.id === state.channel);

  $('channel-title').textContent = channel ? channel.name : 'Not connected';
  $('channel-meta').textContent = channel
    ? `${members.length} ${members.length === 1 ? 'person' : 'people'}${channel.description ? ' · ' + channel.description : ''}`
    : 'Pick a channel to start talking';

  $('empty-state').hidden = !!state.channel;
  $('participants').hidden = !state.channel;
  $('btn-leave').disabled = !state.channel;

  participants.sync(members, net.selfId, volumeFor);

  keepalive.setMetadata({
    channel: channel?.name ?? '',
    server: state.server.name,
    people: members.length
  });
  updateDiagnostics();
}

/* ============================================================
   Channels
   ============================================================ */

async function joinChannel(id, password) {
  if (state.channel === id) return;

  const channel = state.channels.find((c) => c.id === id);

  // Locked channels are gated before the microphone is ever touched.
  if (channel?.locked) {
    const known = password ?? channelPassword(id);
    if (!known) {
      openJoinDialog(channel);
      return;
    }
    password = known;
  }

  if (!audio.started) {
    try {
      await audio.start();
      await mesh.replaceTrack(audio.outboundTrack);
      refreshDevices();
    } catch (err) {
      console.error(err);
      toast(
        err?.name === 'NotAllowedError'
          ? 'Microphone permission was denied.'
          : 'Could not open the microphone.',
        'bad'
      );
      return;
    }
  }

  await audio.ensureContext();
  await audio.playBus();

  // The server confirms by sending a roster; applyRoster finishes the join.
  state.pendingJoin = { id, password: password ?? '' };
  net.send({ t: 'join', channel: id, password });
  document.body.classList.remove('channels-open');
  requestFullscreen();
}

/** Runs once the server has actually put us in a channel. */
function onJoined(id) {
  clearChat();
  setMicEnabled(true);
  keepalive.setActive(true);

  const pending = state.pendingJoin;
  if (pending?.id === id && pending.password) channelPassword(id, pending.password);
  state.pendingJoin = null;
  askForNotifications();
}

function leaveChannel() {
  net.send({ t: 'leave' });
  mesh.closeAll();
  state.channel = null;
  state.pendingJoin = null;
  releasePTTLatch();
  setMicEnabled(false);
  keepalive.setActive(false);
  // Nothing to transmit any more: hand the microphone back to the system.
  audio.stopCapture();
  clearChat();
  renderAll();
  refreshDevices();
}

/* ============================================================
   Microphone controls
   ============================================================ */

function currentMode() {
  if (!state.micEnabled || state.deafened) return 'muted';
  return settings.micMode === 'ptt' ? 'ptt' : 'open';
}

function setMicEnabled(on) {
  state.micEnabled = on;
  applyMicState();
}

function applyMicState() {
  const mode = currentMode();

  // A latch only makes sense in push-to-talk; drop it on any other transition.
  if (mode !== 'ptt' && pttState.latched) {
    pttState.latched = false;
    pttState.lastDown = 0;
    audio.setPTT(false);
  }

  audio.setMode(mode);

  const btn = $('btn-mic');
  btn.dataset.state = mode === 'muted' ? 'muted' : 'live';
  btn.setAttribute('aria-pressed', String(mode === 'muted'));
  btn.querySelector('.dock-label').textContent = mode === 'muted' ? 'Muted' : 'Mic on';

  document.body.classList.toggle('is-ptt', mode === 'ptt');
  $('stat-mode').textContent =
    mode === 'muted'
      ? 'Muted'
      : mode === 'ptt'
        ? pttState.latched
          ? 'Push to talk · locked'
          : 'Push to talk'
        : 'Voice activity';

  if (mode === 'ptt') paintPTT();

  net.send({ t: 'state', mic: mode, deaf: state.deafened, speaking: audio.speaking });
}

function toggleMic() {
  if (!state.channel) {
    toast('Join a channel first.');
    return;
  }
  setMicEnabled(!state.micEnabled);
}

function setDeafened(on) {
  state.deafened = on;
  audio.setDeafened(on);

  // Deafening also mutes the mic — talking to people you cannot hear is rude.
  if (on) {
    state.micBeforeDeafen = state.micEnabled;
    state.micEnabled = false;
  } else {
    state.micEnabled = state.micBeforeDeafen;
  }

  $('btn-deafen').setAttribute('aria-pressed', String(on));
  applyMicState();
}

audio.addEventListener('speaking', ({ detail }) => {
  if (state.self) state.self.speaking = detail;
  net.send({ t: 'state', mic: currentMode(), deaf: state.deafened, speaking: detail });
  const card = participants.cards.get(net.selfId);
  card?.root.classList.toggle('is-speaking', detail && currentMode() !== 'muted');
});

/* Push to talk ------------------------------------------------ */

/**
 * Press-and-hold by default, with an optional double-tap latch:
 *
 *   tap ............... talk while held, closes on release
 *   tap tap (fast) .... latches open, hands-free
 *   tap (while latched) releases
 *
 * `settings.pttLatch` is the window in ms; 0 turns latching off entirely.
 */
const pttState = { latched: false, lastDown: 0, releasePress: false };

function pttDown() {
  if (currentMode() !== 'ptt') return;

  if (pttState.latched) {
    // A press while latched means "stop talking".
    pttState.latched = false;
    pttState.releasePress = true;
    pttState.lastDown = 0; // this press must not seed a new double-tap
    audio.setPTT(false);
    paintPTT();
    return;
  }

  const now = performance.now();
  const isDoubleTap = settings.pttLatch > 0 && now - pttState.lastDown < settings.pttLatch;
  pttState.lastDown = now;
  audio.setPTT(true);
  if (isDoubleTap) pttState.latched = true;
  paintPTT();
}

function pttUp() {
  if (currentMode() !== 'ptt') return;
  if (pttState.releasePress) {
    pttState.releasePress = false;
    return;
  }
  if (pttState.latched) return; // stays open until the next press
  audio.setPTT(false);
  paintPTT();
}

/** Drops the latch without touching anything else — used when leaving/muting. */
function releasePTTLatch() {
  pttState.latched = false;
  pttState.releasePress = false;
  pttState.lastDown = 0;
  audio.setPTT(false);
  paintPTT();
}

function paintPTT() {
  const btn = $('btn-ptt');
  const live = audio.ptt;
  btn.classList.toggle('is-held', live && !pttState.latched);
  btn.classList.toggle('is-latched', pttState.latched);
  btn.querySelector('.dock-label').textContent = pttState.latched
    ? 'Locked'
    : live
      ? 'Talking'
      : 'Hold';
  if (state.channel) {
    $('stat-mode').textContent = pttState.latched ? 'Push to talk · locked' : 'Push to talk';
  }
}

const isTyping = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');

document.addEventListener('keydown', (e) => {
  if (state.bindingKey) {
    e.preventDefault();
    const code = e.code === 'Escape' ? settings.pttKey : e.code;
    set({ pttKey: code });
    $('ptt-key-label').textContent = keyLabel(code);
    state.bindingKey = false;
    $('btn-bind-ptt').classList.remove('is-binding');
    return;
  }

  if (isTyping()) return;

  if (e.code === settings.pttKey && settings.micMode === 'ptt') {
    if (!e.repeat) {
      e.preventDefault();
      pttDown();
    }
    return;
  }

  if (e.code === 'KeyM' && !e.ctrlKey && !e.metaKey && !e.altKey) toggleMic();
  if (e.code === 'KeyD' && !e.ctrlKey && !e.metaKey && !e.altKey) setDeafened(!state.deafened);
});

document.addEventListener('keyup', (e) => {
  if (e.code === settings.pttKey && settings.micMode === 'ptt') pttUp();
});

// A held key that loses focus would stay stuck open — but a deliberate latch
// is meant to survive tabbing away.
window.addEventListener('blur', () => {
  if (!pttState.latched) pttUp();
});

function bindHold(btn) {
  const down = (e) => {
    e.preventDefault();
    pttDown();
  };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', pttUp);
  btn.addEventListener('pointercancel', pttUp);
  btn.addEventListener('pointerleave', pttUp);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

const keyLabel = (code) =>
  ({ Space: 'Space', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl', ShiftLeft: 'Left Shift', AltLeft: 'Left Alt' })[code] ??
  code.replace(/^(Key|Digit)/, '');

/* ============================================================
   Meters
   ============================================================ */

const meterFill = (node, v) => {
  node.style.width = `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
};

/** Maps dBFS onto a 0..1 bar with a useful amount of resolution around speech. */
const dbToUnit = (db) => Math.max(0, Math.min(1, (db + 70) / 65));

audio.addEventListener('level', ({ detail }) => {
  const v = dbToUnit(detail.db);
  meterFill($('self-meter').firstElementChild, v);
  if (!$('settings').hidden) {
    meterFill($('settings-meter').firstElementChild, v);
    meterFill($('threshold-meter').firstElementChild, v);
  }
  participants.setLevel(net.selfId, v);
});

function meterLoop() {
  if (document.visibilityState === 'visible' && state.channel) {
    const levels = audio.peerLevels();
    for (const [id, v] of Object.entries(levels)) participants.setLevel(id, v);
  }
  requestAnimationFrame(meterLoop);
}
requestAnimationFrame(meterLoop);

mesh.addEventListener('stats', ({ detail }) => {
  state.stats = detail;
  for (const [id, s] of Object.entries(detail)) {
    const bits = [];
    if (s.rtt != null) bits.push(`${s.rtt} ms`);
    if (s.loss) bits.push(`${s.loss}% loss`);
    if (!bits.length) bits.push(s.state === 'connected' ? 'connected' : s.state);
    participants.setSub(id, bits.join(' · '));
  }
  updateDiagnostics();
});

mesh.addEventListener('peer-state', ({ detail }) => {
  if (detail.state === 'connected') {
    const user = state.users.find((u) => u.id === detail.id);
    if (user) audio.setPeerVolume(detail.id, peerVolume(user.name));
  }
});

/* ============================================================
   Notifications
   ============================================================ */

let swRegistration = null;

const notificationsUsable = () =>
  'Notification' in window && settings.notifications && Notification.permission === 'granted';

/**
 * Asks once, and only off the back of a real user action (joining a channel or
 * flipping the switch) — browsers reject a bare prompt on page load.
 */
async function askForNotifications(force = false) {
  if (!('Notification' in window)) return false;
  if (!force && !settings.notifications) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/**
 * Chat notification. Skipped when you are plainly already reading the channel,
 * so the only ones you get are the ones you would otherwise miss.
 */
async function notifyChat(message) {
  if (message.from === net.selfId) return;
  if (!notificationsUsable()) return;

  // Only for messages you would actually miss. A visible, focused window gets
  // the in-app toast instead — two alerts for one message is noise.
  const watching = document.visibilityState === 'visible' && document.hasFocus();
  if (watching) return;

  const channel = state.channels.find((c) => c.id === message.channel);
  const options = {
    body: message.text,
    icon: new URL('icons/icon-192.png', document.baseURI).pathname,
    badge: new URL('icons/icon-192.png', document.baseURI).pathname,
    // One notification per channel, replaced as messages arrive.
    tag: `voicema-chat-${message.channel}`,
    renotify: true,
    timestamp: message.ts,
    data: { url: new URL(`./?channel=${message.channel}`, document.baseURI).href }
  };
  const title = `${message.name}${channel ? ' · ' + channel.name : ''}`;

  try {
    // The service worker route is the one that works on Android with the
    // screen off; the constructor is the desktop fallback.
    if (swRegistration?.showNotification) await swRegistration.showNotification(title, options);
    else new Notification(title, options);
  } catch (err) {
    console.warn('notify: could not show notification', err);
  }
}

function updateNotificationHint() {
  const hint = $('notification-hint');
  if (!hint) return;
  if (!('Notification' in window)) {
    hint.textContent = 'This browser does not support notifications.';
  } else if (Notification.permission === 'denied') {
    hint.textContent =
      'Blocked in your browser settings — allow notifications for this site to switch it back on.';
  } else if (Notification.permission === 'granted') {
    hint.textContent = 'Allowed. Messages arrive while the app is in the background.';
  } else {
    hint.textContent = 'You will be asked for permission the next time you join a channel.';
  }
}

/* ============================================================
   Fullscreen
   ============================================================ */

/** Best-effort: browsers only grant this from inside a user gesture. */
function requestFullscreen() {
  if (!settings.fullscreen) return;
  // An installed PWA already runs fullscreen via the manifest.
  if (matchMedia('(display-mode: fullscreen)').matches) return;
  const el = document.documentElement;
  if (document.fullscreenElement || !el.requestFullscreen) return;
  el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {
    /* refused outside a gesture, or unsupported (iOS Safari) */
  });
}

function exitFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

/* ============================================================
   Devices
   ============================================================ */

async function refreshDevices() {
  const { inputs, outputs } = await audio.listDevices();

  const fill = (select, list, current, emptyLabel) => {
    select.replaceChildren();
    if (!list.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = emptyLabel;
      select.appendChild(opt);
      return;
    }
    for (const d of list) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.label;
      opt.selected = d.id === current;
      select.appendChild(opt);
    }
  };

  fill($('sel-input'), inputs, settings.inputId, 'Grant microphone access to list devices');
  fill($('sel-output'), outputs, settings.outputId, 'System default');

  $('input-hint').textContent = audio.started
    ? `Using: ${audio.inputLabel || 'default microphone'}`
    : 'Join a channel to activate the microphone.';

  $('output-hint').textContent = audio.supportsSinkId
    ? 'Pick any speaker, headset or earbuds.'
    : 'This browser follows the system output. Connect earbuds and audio moves with them.';
}

audio.addEventListener('devices', () => {
  refreshDevices();
  toast('Audio devices changed');
});

/* ============================================================
   Settings
   ============================================================ */

function openSheet(sheet, backdrop) {
  backdrop.hidden = false;
  sheet.hidden = false;
}
function closeSheet(sheet, backdrop) {
  backdrop.hidden = true;
  sheet.hidden = true;
}

function wireSettings() {
  const s = $('settings');
  const b = $('settings-backdrop');
  $('open-settings').addEventListener('click', () => {
    refreshDevices();
    updateDiagnostics();
    openSheet(s, b);
  });
  $('close-settings').addEventListener('click', () => closeSheet(s, b));
  b.addEventListener('click', () => closeSheet(s, b));

  for (const tab of $('settings-tabs').children) {
    tab.addEventListener('click', () => {
      for (const t of $('settings-tabs').children) t.classList.toggle('is-active', t === tab);
      for (const panel of document.querySelectorAll('.tab-panel')) {
        panel.classList.toggle('is-active', panel.dataset.panel === tab.dataset.tab);
      }
    });
  }

  // --- audio ---------------------------------------------------
  $('sel-input').addEventListener('change', async (e) => {
    await audio.setInputDevice(e.target.value);
    await mesh.replaceTrack(audio.outboundTrack);
    save();
    refreshDevices();
    toast('Microphone changed', 'good');
  });

  $('sel-output').addEventListener('change', async (e) => {
    const ok = await audio.applyOutputDevice(e.target.value);
    save();
    toast(ok ? 'Output changed' : 'Output follows the system default', ok ? 'good' : '');
  });

  const gain = $('rng-gain');
  gain.value = String(Math.round(settings.micGain * 100));
  $('val-gain').textContent = `${gain.value}%`;
  gain.addEventListener('input', () => {
    $('val-gain').textContent = `${gain.value}%`;
    audio.setMicGain(Number(gain.value) / 100);
    save();
  });

  const vol = $('rng-volume');
  vol.value = String(Math.round(settings.volume * 100));
  $('val-volume').textContent = `${vol.value}%`;
  vol.addEventListener('input', () => {
    $('val-volume').textContent = `${vol.value}%`;
    audio.setVolume(Number(vol.value) / 100);
    save();
  });

  $('btn-test-output').addEventListener('click', () => audio.playTone());

  for (const [id, key] of [
    ['chk-aec', 'aec'],
    ['chk-ns', 'ns'],
    ['chk-agc', 'agc']
  ]) {
    const box = $(id);
    box.checked = settings[key];
    box.addEventListener('change', async () => {
      set({ [key]: box.checked });
      await audio.applyProcessing();
      await mesh.replaceTrack(audio.outboundTrack);
    });
  }

  // --- voice ---------------------------------------------------
  for (const btn of $('seg-mode').children) {
    btn.classList.toggle('is-active', btn.dataset.mode === settings.micMode);
    btn.addEventListener('click', () => {
      set({ micMode: btn.dataset.mode });
      for (const x of $('seg-mode').children) x.classList.toggle('is-active', x === btn);
      $('field-threshold').hidden = btn.dataset.mode !== 'open';
      $('field-ptt').hidden = btn.dataset.mode !== 'ptt';
      applyMicState();
    });
  }
  $('field-threshold').hidden = settings.micMode !== 'open';
  $('field-ptt').hidden = settings.micMode !== 'ptt';

  const th = $('rng-threshold');
  th.value = String(settings.threshold);
  const paintThreshold = () => {
    $('val-threshold').textContent = `${th.value} dB`;
    const marker = $('threshold-meter').querySelector('b');
    if (marker) marker.style.left = `${dbToUnit(Number(th.value)) * 100}%`;
  };
  paintThreshold();
  th.addEventListener('input', () => {
    audio.setThreshold(Number(th.value));
    paintThreshold();
    save();
  });

  const hold = $('rng-hold');
  hold.value = String(settings.hold);
  $('val-hold').textContent = `${hold.value} ms`;
  hold.addEventListener('input', () => {
    $('val-hold').textContent = `${hold.value} ms`;
    audio.setHold(Number(hold.value));
    save();
  });

  $('ptt-key-label').textContent = keyLabel(settings.pttKey);
  $('btn-bind-ptt').addEventListener('click', () => {
    state.bindingKey = true;
    $('ptt-key-label').textContent = 'Press any key…';
    $('btn-bind-ptt').classList.add('is-binding');
  });

  for (const btn of $('seg-quality').children) {
    btn.classList.toggle('is-active', btn.dataset.q === settings.quality);
    btn.addEventListener('click', () => {
      set({ quality: btn.dataset.q });
      for (const x of $('seg-quality').children) x.classList.toggle('is-active', x === btn);
      $('quality-hint').textContent = QUALITY[btn.dataset.q].label;
      mesh.refreshQuality();
    });
  }
  $('quality-hint').textContent = QUALITY[settings.quality].label;

  const latch = $('rng-latch');
  latch.value = String(settings.pttLatch);
  const paintLatch = () => {
    $('val-latch').textContent = Number(latch.value) === 0 ? 'off' : `${latch.value} ms`;
  };
  paintLatch();
  latch.addEventListener('input', () => {
    set({ pttLatch: Number(latch.value) });
    paintLatch();
    if (settings.pttLatch === 0) releasePTTLatch();
  });

  const sounds = $('chk-sounds');
  sounds.checked = settings.sounds;
  sounds.addEventListener('change', () => set({ sounds: sounds.checked }));

  const notifications = $('chk-notifications');
  notifications.checked = settings.notifications;
  notifications.addEventListener('change', async () => {
    set({ notifications: notifications.checked });
    if (notifications.checked) {
      const granted = await askForNotifications(true);
      if (!granted) {
        notifications.checked = false;
        set({ notifications: false });
        toast('Notification permission was not granted.', 'bad');
      } else {
        toast('Chat notifications on', 'good');
      }
    }
    updateNotificationHint();
  });
  updateNotificationHint();

  // --- app -----------------------------------------------------
  const nameField = $('set-name');
  nameField.value = settings.name;
  nameField.addEventListener('change', () => {
    const name = nameField.value.trim().slice(0, 24);
    if (!name) return;
    set({ name });
    net.send({ t: 'rename', name });
    $('self-name').textContent = name;
    $('self-avatar').textContent = initials(name);
  });

  for (const btn of $('seg-theme').children) {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
  }

  const wake = $('chk-wakelock');
  wake.checked = settings.wakeLock;
  wake.addEventListener('change', async () => {
    set({ wakeLock: wake.checked });
    if (wake.checked) await keepalive.requestWakeLock();
    else await keepalive.releaseWakeLock();
  });

  const bg = $('chk-background');
  bg.checked = settings.background;
  bg.addEventListener('change', () => {
    set({ background: bg.checked });
    if (bg.checked) keepalive.setupMediaSession();
  });

  const fullscreen = $('chk-fullscreen');
  fullscreen.checked = settings.fullscreen;
  fullscreen.addEventListener('change', () => {
    set({ fullscreen: fullscreen.checked });
    if (fullscreen.checked) requestFullscreen();
    else exitFullscreen();
  });

  const mixer = $('chk-mixer');
  mixer.checked = settings.mixer;
  mixer.addEventListener('change', async () => {
    await audio.setMixerRouting(mixer.checked);
    toast(mixer.checked ? 'Routing through mixer' : 'Playing directly', 'good');
    updateDiagnostics();
  });

  const caps = keepalive.capabilities();
  $('background-hint').textContent = caps.ios
    ? 'On iPhone and iPad, audio continues with the screen locked only while the tab stays in the foreground app slot. Android and desktop keep running when minimised.'
    : 'Audio keeps flowing with the screen off. Android shows the call in your notification shade.';
}

function wireChannelDialog() {
  const sheet = $('channel-dialog');
  const backdrop = $('channel-backdrop');
  $('add-channel').addEventListener('click', () => openSheet(sheet, backdrop));
  $('close-channel-dialog').addEventListener('click', () => closeSheet(sheet, backdrop));
  backdrop.addEventListener('click', () => closeSheet(sheet, backdrop));

  $('channel-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('channel-name').value.trim();
    if (!name) return;
    const password = $('channel-pass').value;
    state.lastCreatedPassword = password;
    net.send({
      t: 'channel:create',
      name,
      description: $('channel-desc').value.trim(),
      password: password || undefined
    });
    $('channel-name').value = '';
    $('channel-desc').value = '';
    $('channel-pass').value = '';
    closeSheet(sheet, backdrop);
  });
}

/* ---------- locked channel prompt ---------- */

function openJoinDialog(channel, error = '') {
  state.joinTarget = channel;
  $('join-channel-name').textContent = channel?.name ?? 'This channel';
  $('join-error').textContent = error;
  $('join-pass').value = '';
  openSheet($('join-dialog'), $('join-backdrop'));
  setTimeout(() => $('join-pass').focus(), 120);
}

function wireJoinDialog() {
  const sheet = $('join-dialog');
  const backdrop = $('join-backdrop');
  const close = () => {
    closeSheet(sheet, backdrop);
    state.joinTarget = null;
  };
  $('close-join-dialog').addEventListener('click', close);
  backdrop.addEventListener('click', close);

  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const password = $('join-pass').value;
    if (!password) {
      $('join-error').textContent = 'Enter the channel password.';
      return;
    }
    const target = state.joinTarget;
    closeSheet(sheet, backdrop);
    if (target) joinChannel(target.id, password);
  });
}

function updateDiagnostics() {
  const host = $('diag');
  if (!host) return;
  const caps = keepalive.capabilities();
  const peers = Object.values(state.stats);
  const rtts = peers.map((p) => p.rtt).filter((v) => v != null);

  const rows = [
    ['Signalling', net.state],
    ['Server ping', net.latency == null ? '—' : `${net.latency} ms`],
    ['Peers', String(mesh.peers.size)],
    ['Peer RTT', rtts.length ? `${Math.max(...rtts)} ms max` : '—'],
    ['Codec', `Opus ${QUALITY[settings.quality].bitrate / 1000} kbps`],
    ['Gate', audio.usingWorklet ? 'AudioWorklet' : 'fallback timer'],
    ['Routing', settings.mixer ? 'mixer bus' : 'direct elements'],
    ['Output select', caps.sinkId ? 'supported' : 'system default only'],
    ['Wake lock', caps.wakeLock ? (keepalive.locked ? 'held' : 'idle') : 'unsupported'],
    ['Media session', caps.mediaSession ? 'active' : 'unsupported']
  ];

  host.innerHTML = rows
    .map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`)
    .join('');
}

/* ============================================================
   Chrome wiring
   ============================================================ */

function wireChrome() {
  $('btn-mic').addEventListener('click', toggleMic);
  $('btn-deafen').addEventListener('click', () => setDeafened(!state.deafened));
  $('btn-leave').addEventListener('click', leaveChannel);
  bindHold($('btn-ptt'));

  $('open-channels').addEventListener('click', () =>
    document.body.classList.add('channels-open')
  );
  $('close-channels').addEventListener('click', () =>
    document.body.classList.remove('channels-open')
  );

  const chat = $('chat');
  $('toggle-chat').addEventListener('click', () => {
    chat.hidden = !chat.hidden;
    $('toggle-chat').setAttribute('aria-pressed', String(!chat.hidden));
    $('toggle-chat').classList.remove('has-unread');
    if (!chat.hidden) $('chat-input').focus();
  });
  $('close-chat').addEventListener('click', () => {
    chat.hidden = true;
    $('toggle-chat').setAttribute('aria-pressed', 'false');
  });

  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text) return;
    if (!state.channel) {
      toast('Join a channel to chat.');
      return;
    }
    net.send({ t: 'chat', text });
    input.value = '';
  });

  $('toggle-theme').addEventListener('click', () => {
    const order = ['light', 'dark', 'system'];
    applyTheme(order[(order.indexOf(settings.theme) + 1) % order.length]);
  });

  // Lock-screen and headset controls.
  keepalive.addEventListener('request-mute', () => setMicEnabled(false));
  keepalive.addEventListener('request-unmute', () => setMicEnabled(true));
  keepalive.addEventListener('request-toggle-mic', toggleMic);
  keepalive.addEventListener('request-leave', leaveChannel);
  keepalive.addEventListener('change', () => {
    $('stat-lock').hidden = !keepalive.locked;
    updateDiagnostics();
  });

  // Any tap is a chance to satisfy autoplay rules we may have missed.
  document.addEventListener(
    'pointerdown',
    () => {
      if (state.channel) keepalive.resumeAudio();
    },
    { passive: true }
  );
}

/* ============================================================
   PWA
   ============================================================ */

function wirePWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register(new URL('sw.js', document.baseURI), { scope: new URL('./', document.baseURI).pathname })
      .then((reg) => {
        // Kept so chat notifications can go through the worker, which is what
        // lets them appear on Android with the screen off.
        swRegistration = reg;
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          sw?.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              toast('Update ready — reopen to apply');
            }
          });
        });
      })
      .catch((err) => console.warn('sw: registration failed', err));
  }

  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    $('btn-install').hidden = false;
  });

  $('btn-install').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $('btn-install').hidden = true;
  });

  window.addEventListener('appinstalled', () => toast('Installed', 'good'));

  // Tapping a chat notification asks us to surface the conversation.
  navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.data?.type !== 'open-chat') return;
    $('chat').hidden = false;
    $('toggle-chat').setAttribute('aria-pressed', 'true');
    $('toggle-chat').classList.remove('has-unread');
  });

  // Leaving with a live mic should hang up cleanly for everyone else.
  window.addEventListener('pagehide', () => {
    if (state.channel) net.send({ t: 'leave' });
  });
}

/* ============================================================
   Boot
   ============================================================ */

applyTheme(settings.theme);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (settings.theme === 'system') applyTheme('system');
});

wireSheen();
buildGate();
wireChrome();
wireSettings();
wireChannelDialog();
wireJoinDialog();
wirePWA();
updateDiagnostics();

// Deep link: /?channel=general joins straight from a home-screen shortcut.
const wanted = new URLSearchParams(location.search).get('channel');
if (wanted) {
  net.addEventListener(
    'welcome',
    () => {
      setTimeout(() => joinChannel(wanted), 150);
    },
    { once: true }
  );
}

// Returning users skip the form entirely.
if (settings.name) {
  $('gate-name').value = settings.name;
}

// Diagnostics handle. Invaluable when someone reports "I can't hear Sam" —
// `voicema.mesh.summary()` and `voicema.audio.peers` tell you why in seconds.
window.voicema = { state, audio, net, mesh, keepalive, settings };
