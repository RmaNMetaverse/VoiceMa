import { settings } from './store.js';

/**
 * Keeps the call running when the phone is not being looked at.
 *
 * Two separate problems, two mechanisms:
 *
 *  1. Screen stays ON while you are looking at the app  -> Screen Wake Lock API.
 *     The lock is dropped by the browser whenever the page is hidden, so it has
 *     to be re-taken on every visibilitychange.
 *
 *  2. Audio keeps flowing when the screen is OFF        -> media playback.
 *     Mobile browsers freeze background tabs, but a tab that is actively
 *     playing audio through a media element is exempt. AudioEngine keeps one
 *     <audio> element playing permanently; here we advertise it to the OS via
 *     the Media Session API, hold audio focus, and restart playback if the
 *     platform pauses us (a call, another app, a Bluetooth switch).
 */
export class Keepalive extends EventTarget {
  constructor(audio) {
    super();
    this.audio = audio;
    this.lock = null;
    this.active = false;
    this.meta = { channel: '', server: 'VoiceMa', people: 0 };
    this.watchdog = null;

    this.supportsWakeLock = 'wakeLock' in navigator;
    this.supportsMediaSession = 'mediaSession' in navigator;

    document.addEventListener('visibilitychange', () => this.onVisibility());
    window.addEventListener('pageshow', () => this.onVisibility());
    window.addEventListener('focus', () => this.resumeAudio());

    // Some platforms pause media when audio focus is lost and never resume it.
    this.audio.bus?.addEventListener('pause', () => {
      if (this.active && (settings.background || document.visibilityState === 'visible')) {
        setTimeout(() => this.audio.playBus(), 250);
      }
    });
  }

  // ---------------------------------------------------------------

  /** Called when the user joins (true) or leaves (false) a channel. */
  async setActive(active) {
    if (this.active === active) return;
    this.active = active;

    if (active) {
      await this.audio.setSessionActive(true, settings.background);
      await this.requestWakeLock();
      if (settings.background) {
        this.setupMediaSession();
        this.startWatchdog();
      }
    } else {
      await this.releaseWakeLock();
      this.stopWatchdog();
      this.clearMediaSession();
      await this.audio.setSessionActive(false, false);
    }
    this.emit();
  }

  setMetadata(meta) {
    Object.assign(this.meta, meta);
    if (this.active) this.setupMediaSession();
  }

  // ---------------------------------------------------------------
  // Screen Wake Lock
  // ---------------------------------------------------------------

  async requestWakeLock() {
    if (!this.supportsWakeLock || !settings.wakeLock || !this.active) return false;
    if (this.lock && !this.lock.released) return true;
    if (document.visibilityState !== 'visible') return false;

    try {
      this.lock = await navigator.wakeLock.request('screen');
      this.lock.addEventListener('release', () => {
        this.lock = null;
        this.emit();
      });
      this.emit();
      return true;
    } catch (err) {
      // Denied on low battery, or blocked by policy — not fatal.
      console.warn('wakelock: request rejected', err?.message ?? err);
      return false;
    }
  }

  async releaseWakeLock() {
    try {
      await this.lock?.release();
    } catch {
      /* already gone */
    }
    this.lock = null;
    this.emit();
  }

  get locked() {
    return !!this.lock && !this.lock.released;
  }

  async onVisibility() {
    if (document.visibilityState === 'visible') {
      await this.resumeAudio();
      if (this.active) await this.requestWakeLock();
    } else if (this.active && settings.background) {
      // Going into the background is exactly when playback must not stop.
      this.resumeAudio();
    }
    this.emit();
  }

  // ---------------------------------------------------------------
  // Background audio
  // ---------------------------------------------------------------

  async resumeAudio() {
    const ctx = this.audio.ctx;
    if (ctx && ctx.state === 'suspended') await ctx.resume().catch(() => {});
    if (this.active && this.audio.bus?.paused) await this.audio.playBus();
  }

  /**
   * Presents the channel as a media session. Beyond the lock-screen controls,
   * this is what tells Android "this tab is a media player" so it survives the
   * screen turning off.
   */
  setupMediaSession() {
    if (!this.supportsMediaSession || !settings.background) return;
    const ms = navigator.mediaSession;

    try {
      ms.metadata = new MediaMetadata({
        title: this.meta.channel ? `${this.meta.channel}` : 'Voice channel',
        artist: `${this.meta.people} in channel`,
        album: this.meta.server,
        artwork: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      });
      ms.playbackState = 'playing';
    } catch {
      /* MediaMetadata unsupported */
    }

    const handle = (action, fn) => {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        /* action unsupported on this platform */
      }
    };

    // Lock-screen buttons map onto mute, so a phone in a pocket is still usable.
    handle('play', () => {
      this.resumeAudio();
      this.dispatchEvent(new CustomEvent('request-unmute'));
      ms.playbackState = 'playing';
    });
    handle('pause', () => {
      this.dispatchEvent(new CustomEvent('request-mute'));
      // Never actually pause the element: that would end background audio.
      ms.playbackState = 'playing';
      this.resumeAudio();
    });
    handle('stop', () => this.dispatchEvent(new CustomEvent('request-leave')));
    handle('togglemicrophone', () => this.dispatchEvent(new CustomEvent('request-toggle-mic')));
    handle('previoustrack', null);
    handle('nexttrack', null);
    handle('seekbackward', null);
    handle('seekforward', null);
  }

  clearMediaSession() {
    if (!this.supportsMediaSession) return;
    navigator.mediaSession.playbackState = 'none';
    navigator.mediaSession.metadata = null;
  }

  /** Applies the preference immediately; disabling it used to change only UI. */
  async setBackgroundEnabled(enabled) {
    this.audio.setBackgroundEnabled(enabled);
    if (!this.active) return;
    if (enabled) {
      this.setupMediaSession();
      this.startWatchdog();
      await this.resumeAudio();
    } else {
      this.stopWatchdog();
      this.clearMediaSession();
    }
    this.emit();
  }

  /**
   * Cheap insurance: if the element ever stops while we are in a channel, start
   * it again. Timers are throttled in the background, but a throttled check is
   * still better than a permanently silent call.
   */
  startWatchdog() {
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (!this.active) return;
      if (this.audio.bus?.paused) this.audio.playBus();
      if (this.audio.ctx?.state === 'suspended') this.audio.ctx.resume().catch(() => {});
    }, 4000);
  }

  stopWatchdog() {
    clearInterval(this.watchdog);
    this.watchdog = null;
  }

  emit() {
    this.dispatchEvent(new CustomEvent('change', { detail: { locked: this.locked } }));
  }

  /** One-line summary of what this platform actually supports. */
  capabilities() {
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent);
    return {
      wakeLock: this.supportsWakeLock,
      mediaSession: this.supportsMediaSession,
      sinkId: this.audio.supportsSinkId,
      ios
    };
  }
}
