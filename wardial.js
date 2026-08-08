// wardial.js — the hunt: theater pacing + sequencing around a REAL connect
// attempt (connect.js's dialReal). Outcomes are no longer simulated — a
// live TCP attempt against the target from directory.js decides BUSY vs
// NO CARRIER vs RING—NO ANSWER vs CONNECT, mapped per the design spec:
//   ECONNREFUSED -> BUSY · unreachable/DNS -> NO CARRIER · timeout -> RING—NO ANSWER

const REALISM_PRESETS = {
  "1987":     { label: "1987 (patient)",   speed: 1.0 },
  "standard": { label: "Standard",         speed: 1.5 },
  "arcade":   { label: "Arcade (brisk)",   speed: 2.4 },
};

const BAUDS = [1200, 2400, 9600, 14400];
const CONNECT_TIMEOUT_MS = 7500;

class WardialSequencer {
  constructor(audio) {
    this.audio = audio;
    this.controller = null;
  }

  stop() {
    this.controller?.abort();
    this.controller = null;
  }

  // runs one attempt against `entry`; calls onEvent(stage, data) as it progresses.
  // stages: 'dialing' | 'digit' | 'ringing' | 'busy' | 'no-answer' | 'no-carrier' | 'handshake' | 'connect'
  async attempt(entry, realismKey, onEvent) {
    this.controller = new AbortController();
    const { signal } = this.controller;
    const preset = REALISM_PRESETS[realismKey] || REALISM_PRESETS.standard;
    const number = syntheticNumber(entry);

    onEvent("dialing", { number, entry });
    this.audio.dialTone(0.35 / preset.speed);
    await sleep(400 / preset.speed, signal);
    if (signal.aborted) return { result: "aborted" };

    await this.audio.dialDigits(number.replace("-", ""), {
      onDigit: () => onEvent("digit", { number, entry }),
    });
    if (signal.aborted) return { result: "aborted" };

    onEvent("ringing", { number, entry });
    const ringAudio = this.audio.ring(6, signal); // looped audio, cut short once the real result lands
    const real = await dialReal(entry, { timeoutMs: CONNECT_TIMEOUT_MS, signal });
    this.controller.abort(); // stop the ring loop immediately
    await ringAudio;

    if (real.status === "aborted") return { result: "aborted" };

    if (real.status === "refused") {
      onEvent("busy", { number, entry });
      await this.audio.busy(2);
      return { result: "BUSY", number, entry };
    }
    if (real.status === "timeout") {
      onEvent("no-answer", { number, entry });
      return { result: "RING — NO ANSWER", number, entry };
    }
    if (real.status === "connected") {
      const baud = BAUDS[Math.floor(Math.random() * BAUDS.length)];
      onEvent("handshake", { number, entry, baud });
      // Mount the terminal on the live socket BEFORE playing the handshake
      // sound: the BBS starts sending real bytes the instant the TCP
      // connect succeeds, and nothing is buffering them client-side — any
      // delay here means the first lines of the real banner are lost.
      onEvent("connect", { number, entry, baud, ws: real.ws });
      await this.audio.handshake(baud);
      return { result: `CONNECT ${baud}`, number, entry, baud, ws: real.ws };
    }
    // unreachable / unknown-id / anything else
    onEvent("no-carrier", { number, entry });
    return { result: "NO CARRIER", number, entry };
  }
}

window.REALISM_PRESETS = REALISM_PRESETS;
window.WardialSequencer = WardialSequencer;
