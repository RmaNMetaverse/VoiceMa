import { settings } from './store.js';

/**
 * The whole audio path lives here.
 *
 * Capture:  mic -> [gate worklet] -> outbound MediaStream -> WebRTC senders
 * Playback: each peer -> gain -> master -> one MediaStreamDestination -> <audio>
 *
 * Everything plays out of a SINGLE <audio> element on purpose:
 *   - it is the one sink we can point at a chosen speaker with setSinkId()
 *   - a continuously playing media element is what stops mobile browsers from
 *     suspending the tab when the screen goes off
 */
export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.stream = null; // raw mic stream
    this.source = null;
    this.gate = null; // AudioWorkletNode (or fallback GainNode)
    this.analyser = null; // fallback level metering only
    this.outDest = null; // -> WebRTC
    this.mixDest = null; // <- peers, -> bus element
    this.master = null;
    this.keepAlive = null;

    this.bus = document.getElementById('audio-bus');
    this.peerHost = document.getElementById('peer-audio');

    this.peers = new Map(); // id -> {stream, el, source, gain, analyser, data}
    this.mode = 'muted'; // muted | open | ptt
    this.ptt = false;
    this.deafened = false;
    this.speaking = false;
    this.level = -100;
    this.usingWorklet = false;
    this.started = false;
    this.inputLabel = '';
    this.outputLabel = '';

    this.supportsSinkId = typeof HTMLMediaElement !== 'undefined' &&
      'setSinkId' in HTMLMediaElement.prototype;

    navigator.mediaDevices?.addEventListener?.('devicechange', () => {
      this.dispatchEvent(new CustomEvent('devices'));
    });
  }

  // ---------------------------------------------------------------
  // Graph setup
  // ---------------------------------------------------------------

  /** Builds the context and the playback side. Safe to call repeatedly. */
  async ensureContext() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
      return this.ctx;
    }

    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });

    this.master = this.ctx.createGain();
    this.master.gain.value = this.deafened ? 0 : settings.volume;

    this.mixDest = this.ctx.createMediaStreamDestination();
    this.master.connect(this.mixDest);

    // An inaudible tone keeps the mixed stream non-empty so the bus element
    // never stalls — a stalled element is a suspended tab on mobile.
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.value = 30;
    g.gain.value = 0.0006;
    osc.connect(g).connect(this.mixDest);
    osc.start();
    this.keepAlive = osc;

    this.bus.srcObject = this.mixDest.stream;
    this.bus.volume = 1;
    await this.playBus();
    await this.applyOutputDevice(settings.outputId).catch(() => {});

    return this.ctx;
  }

  /** Autoplay can reject before a gesture; callers retry on the next tap. */
  async playBus() {
    try {
      await this.bus.play();
      return true;
    } catch {
      return false;
    }
  }

  /** Opens the microphone and wires the capture chain. Needs a user gesture. */
  async start() {
    await this.ensureContext();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: this.constraints(),
      video: false
    });

    // Swap streams cleanly if the mic is re-opened with new settings.
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = stream;
    this.inputLabel = stream.getAudioTracks()[0]?.label ?? '';

    this.source?.disconnect();
    this.source = this.ctx.createMediaStreamSource(stream);

    if (!this.outDest) this.outDest = this.ctx.createMediaStreamDestination();
    if (!this.gate) await this.buildGate();

    this.source.connect(this.gate);
    this.started = true;

    this.applyMode();
    this.dispatchEvent(new CustomEvent('ready'));
    this.dispatchEvent(new CustomEvent('capture', { detail: true }));
    return this.outboundStream;
  }

  async buildGate() {
    try {
      await this.ctx.audioWorklet.addModule('/js/vad-processor.js');
      const node = new AudioWorkletNode(this.ctx, 'gate-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });
      node.port.onmessage = ({ data }) => {
        if (data.type === 'level') {
          this.level = data.db;
          this.dispatchEvent(new CustomEvent('level', { detail: data }));
        } else if (data.type === 'speaking') {
          this.speaking = data.speaking;
          this.dispatchEvent(new CustomEvent('speaking', { detail: data.speaking }));
        }
      };
      node.connect(this.outDest);
      this.gate = node;
      this.usingWorklet = true;
    } catch (err) {
      // Very old engines: fall back to a plain gain node driven from a timer.
      console.warn('audio: AudioWorklet unavailable, using fallback gate', err);
      this.buildFallbackGate();
    }
  }

  buildFallbackGate() {
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    gain.connect(this.outDest);
    this.gate = gain;
    this.analyser = analyser;
    this.usingWorklet = false;

    const buf = new Float32Array(analyser.fftSize);
    let openUntil = 0;
    this.fallbackTimer = setInterval(() => {
      if (!this.source) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const s of buf) sum += s * s;
      const db = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-6);
      this.level = db;

      let open = false;
      if (this.mode === 'ptt') open = this.ptt;
      else if (this.mode === 'open') {
        const now = performance.now();
        if (db > settings.threshold) openUntil = now + settings.hold;
        open = now < openUntil;
      }
      const target = open ? settings.micGain : 0;
      gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.01);

      this.dispatchEvent(new CustomEvent('level', { detail: { db, open } }));
      if (open !== this.speaking) {
        this.speaking = open;
        this.dispatchEvent(new CustomEvent('speaking', { detail: open }));
      }
    }, 60);

    // Keep the analyser fed once a source exists.
    const attach = () => this.source?.connect(analyser);
    setTimeout(attach, 0);
  }

  constraints() {
    const c = {
      echoCancellation: settings.aec,
      noiseSuppression: settings.ns,
      autoGainControl: settings.agc,
      channelCount: 1
    };
    if (settings.inputId && settings.inputId !== 'default') {
      c.deviceId = { exact: settings.inputId };
    }
    return c;
  }

  get outboundStream() {
    return this.outDest?.stream ?? null;
  }

  get outboundTrack() {
    return this.outDest?.stream.getAudioTracks()[0] ?? null;
  }

  // ---------------------------------------------------------------
  // Microphone state
  // ---------------------------------------------------------------

  setMode(mode) {
    this.mode = mode;
    this.applyMode();
  }

  setPTT(down) {
    if (this.ptt === down) return;
    this.ptt = down;
    this.applyMode();
  }

  applyMode() {
    if (!this.gate) return;

    // 0 muted · 1 voice activity · 2 forced open
    const mode = this.mode === 'muted' ? 0 : this.mode === 'ptt' ? (this.ptt ? 2 : 0) : 1;

    if (this.usingWorklet) {
      const p = this.gate.parameters;
      p.get('mode').value = mode;
      p.get('gain').value = settings.micGain;
      p.get('threshold').value = settings.threshold;
      p.get('hold').value = settings.hold;
    }

    // Hard-mute the capture device too, so the OS mic indicator is honest.
    const hardMuted = this.mode === 'muted';
    this.stream?.getAudioTracks().forEach((t) => {
      t.enabled = !hardMuted;
    });

    if (mode === 0 && this.speaking) {
      this.speaking = false;
      this.dispatchEvent(new CustomEvent('speaking', { detail: false }));
    }
  }

  setMicGain(v) {
    settings.micGain = v;
    this.applyMode();
  }

  setThreshold(db) {
    settings.threshold = db;
    this.applyMode();
  }

  setHold(ms) {
    settings.hold = ms;
    this.applyMode();
  }

  /** AEC/NS/AGC changes need the track re-opened to take effect everywhere. */
  async applyProcessing() {
    if (!this.started) return;
    const track = this.stream?.getAudioTracks()[0];
    try {
      await track?.applyConstraints(this.constraints());
    } catch {
      await this.reopen();
    }
  }

  /** Re-opens the mic (new device or new constraints) and hot-swaps senders. */
  async reopen() {
    if (!this.started) return null;
    const previous = this.outboundTrack;
    await this.start();
    // outDest is reused, so the outbound track identity is stable and no
    // renegotiation is needed — senders keep working untouched.
    return previous;
  }

  // ---------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------

  async addPeer(id, stream) {
    await this.ensureContext();
    this.removePeer(id);

    // Chrome will not pull samples from a remote MediaStream unless it is
    // attached to a media element, even when we only consume it via WebAudio.
    const el = document.createElement('audio');
    el.autoplay = true;
    el.playsInline = true;
    el.srcObject = stream;
    el.dataset.peer = id;

    const gain = this.ctx.createGain();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.72;

    let source = null;
    if (settings.mixer) {
      el.muted = true; // audible copy comes out of the mixer bus
      source = this.ctx.createMediaStreamSource(stream);
      source.connect(gain);
      gain.connect(analyser);
      gain.connect(this.master);
    } else {
      // Direct mode: the element itself is audible. Metering still taps WebAudio.
      el.muted = false;
      el.volume = this.deafened ? 0 : settings.volume;
      try {
        source = this.ctx.createMediaStreamSource(stream);
        source.connect(analyser);
      } catch {
        /* metering is optional */
      }
      await this.applySinkTo(el, settings.outputId).catch(() => {});
    }

    this.peerHost.appendChild(el);
    el.play().catch(() => {});

    this.peers.set(id, {
      stream,
      el,
      source,
      gain,
      analyser,
      data: new Uint8Array(analyser.frequencyBinCount),
      volume: 1
    });
    return this.peers.get(id);
  }

  removePeer(id) {
    const p = this.peers.get(id);
    if (!p) return;
    try {
      p.source?.disconnect();
      p.gain.disconnect();
      p.analyser.disconnect();
    } catch {
      /* already torn down */
    }
    p.el.srcObject = null;
    p.el.remove();
    this.peers.delete(id);
  }

  setPeerVolume(id, v) {
    const p = this.peers.get(id);
    if (!p) return;
    p.volume = v;
    p.gain.gain.value = v;
    if (!settings.mixer) p.el.volume = Math.min(1, v * settings.volume) * (this.deafened ? 0 : 1);
  }

  /** 0..1 loudness per peer, for the speaking rings and meters. */
  peerLevels() {
    const out = {};
    for (const [id, p] of this.peers) {
      p.analyser.getByteFrequencyData(p.data);
      let sum = 0;
      for (let i = 0; i < p.data.length; i++) sum += p.data[i];
      out[id] = Math.min(1, sum / p.data.length / 90);
    }
    return out;
  }

  setVolume(v) {
    settings.volume = v;
    if (this.master) this.master.gain.value = this.deafened ? 0 : v;
    if (!settings.mixer) {
      for (const p of this.peers.values()) {
        p.el.volume = this.deafened ? 0 : Math.min(1, v * p.volume);
      }
    }
    this.bus.volume = 1;
  }

  setDeafened(on) {
    this.deafened = on;
    this.setVolume(settings.volume);
  }

  // ---------------------------------------------------------------
  // Devices
  // ---------------------------------------------------------------

  async listDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [] };
    const all = await navigator.mediaDevices.enumerateDevices();
    const label = (d, i, kind) =>
      d.label || (d.deviceId === 'default' ? 'System default' : `${kind} ${i + 1}`);
    return {
      inputs: all
        .filter((d) => d.kind === 'audioinput')
        .map((d, i) => ({ id: d.deviceId, label: label(d, i, 'Microphone') })),
      outputs: all
        .filter((d) => d.kind === 'audiooutput')
        .map((d, i) => ({ id: d.deviceId, label: label(d, i, 'Speaker') }))
    };
  }

  async setInputDevice(id) {
    settings.inputId = id;
    if (this.started) await this.reopen();
  }

  async applySinkTo(el, id) {
    if (!this.supportsSinkId) return false;
    await el.setSinkId(id && id !== 'default' ? id : '');
    return true;
  }

  async applyOutputDevice(id) {
    settings.outputId = id;
    let ok = false;
    try {
      ok = await this.applySinkTo(this.bus, id);
    } catch (err) {
      console.warn('audio: setSinkId failed', err);
    }
    if (!settings.mixer) {
      for (const p of this.peers.values()) await this.applySinkTo(p.el, id).catch(() => {});
    }
    return ok;
  }

  /** Rebuilds playback when the user flips the mixer routing switch. */
  async setMixerRouting(useMixer) {
    settings.mixer = useMixer;
    const entries = [...this.peers.entries()].map(([id, p]) => [id, p.stream]);
    for (const [id] of entries) this.removePeer(id);
    for (const [id, stream] of entries) await this.addPeer(id, stream);
    await this.applyOutputDevice(settings.outputId).catch(() => {});
  }

  /** Short chirp through the real output path, so "test" tests what you hear. */
  async playTone(freq = 660, ms = 320) {
    await this.ensureContext();
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.05);
    await this.playBus();
  }

  /** Two-note cue for joins (rising) and leaves (falling). */
  chime(up = true) {
    if (!this.ctx) return;
    const notes = up ? [587.33, 880] : [880, 587.33];
    notes.forEach((f, i) => setTimeout(() => this.playTone(f, 150), i * 110));
  }

  /**
   * Releases the microphone while keeping playback alive.
   *
   * Called whenever you are not in a channel, so the OS recording indicator
   * goes out and the device is handed back to other apps. The outbound
   * MediaStreamDestination stays in place, so WebRTC senders keep a valid
   * (silent) track and nothing has to renegotiate when you rejoin.
   */
  stopCapture() {
    if (!this.stream && !this.started) return;
    try {
      this.source?.disconnect();
    } catch {
      /* already detached */
    }
    this.source = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.started = false;
    this.inputLabel = '';
    this.mode = 'muted';
    this.ptt = false;
    this.applyMode();

    if (this.speaking) {
      this.speaking = false;
      this.dispatchEvent(new CustomEvent('speaking', { detail: false }));
    }
    this.level = -100;
    this.dispatchEvent(new CustomEvent('level', { detail: { db: -100, open: false } }));
    this.dispatchEvent(new CustomEvent('capture', { detail: false }));
  }

  suspendIfIdle() {
    /* deliberately left as a no-op: suspending kills background audio */
  }

  stop() {
    clearInterval(this.fallbackTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.started = false;
    for (const id of [...this.peers.keys()]) this.removePeer(id);
  }
}
