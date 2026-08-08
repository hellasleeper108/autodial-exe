// audio.js — procedural phone/modem sound engine. No samples, no network calls.
// Everything here is synthesized tones: real DTMF pairs and real US ring/busy
// cadences, generated with Web Audio oscillators.

const DTMF = {
  "1": [697, 1209], "2": [697, 1336], "3": [697, 1477],
  "4": [770, 1209], "5": [770, 1336], "6": [770, 1477],
  "7": [852, 1209], "8": [852, 1336], "9": [852, 1477],
  "*": [941, 1209], "0": [941, 1336], "#": [941, 1477],
};

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  setMuted(m) { this.muted = m; }

  _tone(freqs, startAt, duration, gainPeak = 0.06) {
    if (this.muted) return;
    const ctx = this.ensure();
    const master = ctx.createGain();
    master.gain.setValueAtTime(0, startAt);
    master.gain.linearRampToValueAtTime(gainPeak, startAt + 0.008);
    master.gain.setValueAtTime(gainPeak, startAt + duration - 0.012);
    master.gain.linearRampToValueAtTime(0, startAt + duration);
    master.connect(ctx.destination);
    freqs.forEach((f) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f;
      osc.connect(master);
      osc.start(startAt);
      osc.stop(startAt + duration + 0.02);
    });
  }

  // one key click, roughly synced to typing / dialing digits appearing
  keyClick() {
    if (this.muted) return;
    const ctx = this.ensure();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = 1800 + Math.random() * 400;
    gain.gain.setValueAtTime(0.02, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.03);
  }

  // dial tone hum, played briefly before a call starts
  dialTone(duration = 0.5) {
    const ctx = this.ensure();
    this._tone([350, 440], ctx.currentTime, duration, 0.035);
  }

  // returns a Promise resolving once every digit's DTMF tone has played
  async dialDigits(digits, { onDigit } = {}) {
    const ctx = this.ensure();
    for (const d of digits) {
      const pair = DTMF[d];
      if (pair) this._tone(pair, ctx.currentTime, 0.09, 0.05);
      onDigit && onDigit(d);
      await sleep(120);
    }
  }

  // ring cadence: 2s on / 4s off, 440+480Hz. Plays `cycles` on-periods, aborts if signal.aborted.
  async ring(cycles, signal) {
    const ctx = this.ensure();
    for (let i = 0; i < cycles; i++) {
      if (signal?.aborted) return;
      this._tone([440, 480], ctx.currentTime, 1.6, 0.04);
      await sleep(2000, signal);
      if (signal?.aborted) return;
      await sleep(1200, signal);
    }
  }

  // busy cadence: 480+620Hz, 0.5s on/off
  async busy(cycles = 3, signal) {
    const ctx = this.ensure();
    for (let i = 0; i < cycles; i++) {
      if (signal?.aborted) return;
      this._tone([480, 620], ctx.currentTime, 0.45, 0.045);
      await sleep(500, signal);
      if (signal?.aborted) return;
      await sleep(500, signal);
    }
  }

  // modem handshake: an answer tone + a scaled noisy sweep, length keyed to simulated baud
  async handshake(baud = 2400) {
    if (this.muted) { await sleep(400); return; }
    const ctx = this.ensure();
    const t0 = ctx.currentTime;
    // answer tone
    this._tone([2100], t0, 0.5, 0.05);
    // sweep — faster/shorter for higher baud, slower/longer for low baud
    const sweepDur = baud >= 14400 ? 1.0 : baud >= 9600 ? 1.3 : 1.8;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sawtooth";
    const startF = 900, endF = baud >= 14400 ? 2800 : 2000;
    osc.frequency.setValueAtTime(startF, t0 + 0.5);
    osc.frequency.linearRampToValueAtTime(endF, t0 + 0.5 + sweepDur);
    gain.gain.setValueAtTime(0, t0 + 0.5);
    gain.gain.linearRampToValueAtTime(0.03, t0 + 0.55);
    gain.gain.setValueAtTime(0.03, t0 + 0.5 + sweepDur - 0.05);
    gain.gain.linearRampToValueAtTime(0, t0 + 0.5 + sweepDur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + 0.5);
    osc.stop(t0 + 0.5 + sweepDur + 0.05);

    // noise burst under the sweep for texture
    const bufSize = ctx.sampleRate * (sweepDur + 0.5);
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * 0.35;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.012, t0 + 0.5);
    noiseGain.gain.linearRampToValueAtTime(0, t0 + 1.0 + sweepDur);
    noise.connect(noiseGain).connect(ctx.destination);
    noise.start(t0 + 0.5);

    await sleep((0.5 + sweepDur) * 1000 + 100);
  }

  hangupStatic() {
    if (this.muted) return;
    const ctx = this.ensure();
    const t0 = ctx.currentTime;
    const bufSize = ctx.sampleRate * 0.25;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufSize);
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.05, t0);
    gain.gain.linearRampToValueAtTime(0, t0 + 0.25);
    noise.connect(gain).connect(ctx.destination);
    noise.start(t0);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(id); resolve(); }, { once: true });
  });
}

window.AudioEngine = AudioEngine;
window.sleep = sleep;
