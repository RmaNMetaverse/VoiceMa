/**
 * Microphone gate + level meter, running on the audio thread.
 *
 * Doing this in an AudioWorklet rather than with requestAnimationFrame is what
 * keeps voice activation working when the phone screen is off: rAF and timers
 * are throttled or stopped in a backgrounded tab, but the audio render quantum
 * keeps ticking as long as the AudioContext is running.
 *
 * mode: 0 = muted, 1 = voice activity, 2 = forced open (PTT held / always-on)
 */
class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'gain', defaultValue: 1, minValue: 0, maxValue: 8, automationRate: 'k-rate' },
      { name: 'threshold', defaultValue: -45, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'hold', defaultValue: 300, minValue: 0, maxValue: 5000, automationRate: 'k-rate' },
      { name: 'mode', defaultValue: 0, minValue: 0, maxValue: 2, automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    this.envelope = 0; // smoothed input energy
    this.gate = 0; // current gate gain, ramped to avoid clicks
    this.openUntil = 0; // sampleTime the hold expires at
    this.speaking = false;
    this.telemetrySamples = 0;
    this.peak = 0;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    const ch = input && input[0];

    const gain = params.gain[0];
    const threshold = params.threshold[0];
    const hold = params.hold[0];
    const mode = Math.round(params.mode[0]);

    // A muted mic (including released PTT) needs neither level analysis nor
    // sample-by-sample gate ramps.
    if (mode === 0) {
      for (const out of output) out.fill(0);
      this.gate = 0;
      this.envelope = 0;
      this.openUntil = 0;
      if (this.speaking) {
        this.speaking = false;
        this.port.postMessage({ type: 'speaking', speaking: false });
      }
      return true;
    }

    if (!ch) {
      // No input yet — emit silence but stay alive.
      if (output && output[0]) output[0].fill(0);
      return true;
    }

    // --- level ---------------------------------------------------
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < ch.length; i++) {
      const s = ch[i];
      sum += s * s;
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sum / ch.length);
    // Fast attack, slow release makes the meter feel responsive but steady.
    const coeff = rms > this.envelope ? 0.5 : 0.06;
    this.envelope += (rms - this.envelope) * coeff;
    const db = this.envelope > 0 ? 20 * Math.log10(this.envelope) : -100;
    if (peak > this.peak) this.peak = peak;

    // --- gate decision -------------------------------------------
    let want = 0;
    if (mode === 2) {
      want = 1;
    } else if (mode === 1) {
      const now = currentTime * 1000;
      if (db > threshold) {
        this.openUntil = now + hold;
        want = 1;
      } else if (now < this.openUntil) {
        want = 1; // inside the hold window
      }
    }

    const speaking = want === 1;
    if (speaking !== this.speaking) {
      this.speaking = speaking;
      this.port.postMessage({ type: 'speaking', speaking });
    }

    // --- apply ----------------------------------------------------
    const out = output[0];
    // ~8 ms ramp: fast enough not to clip a word, slow enough not to click.
    const step = 1 / (sampleRate * 0.008);
    for (let i = 0; i < ch.length; i++) {
      if (this.gate < want) this.gate = Math.min(want, this.gate + step);
      else if (this.gate > want) this.gate = Math.max(want, this.gate - step);
      out[i] = ch[i] * gain * this.gate;
    }
    // Mirror to any extra output channels so mono mics fill a stereo sink.
    for (let c = 1; c < output.length; c++) output[c].set(out);

    // --- meter telemetry, ~10 Hz ----------------------------------
    this.telemetrySamples += ch.length;
    if (this.telemetrySamples >= sampleRate / 10) {
      this.telemetrySamples = 0;
      this.port.postMessage({ type: 'level', db, peak: this.peak, open: speaking });
      this.peak = 0;
    }

    return true;
  }
}

registerProcessor('gate-processor', GateProcessor);
