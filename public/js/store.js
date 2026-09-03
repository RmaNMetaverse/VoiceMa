const KEY = 'voicema.settings.v1';
const SETTINGS_VERSION = 2;

const DEFAULTS = {
  settingsVersion: SETTINGS_VERSION,
  name: '',
  hue: null,
  theme: 'system',

  inputId: '',
  outputId: '',
  micGain: 1,
  volume: 1,

  aec: true,
  ns: true,
  agc: true,

  micMode: 'open', // 'open' | 'ptt'
  threshold: -45,
  hold: 300,
  pttKey: 'Space',
  pttLatch: 400, // double-tap window in ms; 0 disables latching
  quality: 'normal', // low | normal | high

  sounds: true,
  notifications: true,
  // Keeping a phone display lit is by far the largest avoidable power cost.
  // Users who really need it can opt in from Settings -> App.
  wakeLock: false,
  background: true,
  fullscreen: true,
  mixer: true,

  peerVolumes: {},
  channelPasswords: {}
};

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const saved = JSON.parse(raw);
    const merged = {
      ...DEFAULTS,
      ...saved,
      peerVolumes: saved.peerVolumes ?? {},
      channelPasswords: saved.channelPasswords ?? {}
    };
    // v1 enabled the screen wake lock by default. Replace that old implicit
    // value once while preserving every other preference.
    if ((saved.settingsVersion ?? 1) < SETTINGS_VERSION) {
      merged.settingsVersion = SETTINGS_VERSION;
      merged.wakeLock = false;
      try {
        localStorage.setItem(KEY, JSON.stringify(merged));
      } catch {
        /* private mode / quota */
      }
    }
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

export const settings = read();

let pending = 0;
export function save() {
  clearTimeout(pending);
  pending = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      /* private mode / quota — settings just won't persist */
    }
  }, 200);
}

export function set(patch) {
  Object.assign(settings, patch);
  save();
  return settings;
}

/** Per-user output volume, remembered by display name so it survives reconnects. */
export function peerVolume(name, value) {
  if (value === undefined) return settings.peerVolumes[name] ?? 1;
  settings.peerVolumes[name] = value;
  save();
  return value;
}

/**
 * Remembered channel passwords, so you type a room code once per device.
 * They unlock nothing on their own — the server re-checks every join.
 */
export function channelPassword(id, value) {
  if (value === undefined) return settings.channelPasswords[id] ?? '';
  if (value === null) delete settings.channelPasswords[id];
  else settings.channelPasswords[id] = value;
  save();
  return value ?? '';
}

export const QUALITY = {
  low: { bitrate: 24000, dtx: true, label: '24 kbps mono — tight networks' },
  normal: { bitrate: 48000, dtx: true, label: '48 kbps mono Opus — balanced and efficient' },
  high: { bitrate: 96000, dtx: true, label: '96 kbps — richest voice quality' }
};
