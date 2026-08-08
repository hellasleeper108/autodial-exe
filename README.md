# AUTODIAL.EXE

A wardialer for a world with no phone lines left to wardial. The dial
sequence (DTMF tones, ring/busy cadence, modem handshake) is theater; the
destination is real — every "CONNECT" hands you a live telnet session with
an actual, currently-listed public BBS, rendered in-browser with xterm.js.

Full design spec (visual system, audio design, roadmap) was written up
separately as a standalone doc; this repo is Phase 1 + Phase 2 of that
roadmap: the hunt (dial theater) and the bridge (real telnet connections).

## Run it

```
npm install
node server.js
```

Then open `http://localhost:8734`. One process serves the static app and
the WebSocket bridge — no separate frontend build step.

## How it works

- `directory.js` — the BBS directory. 10 real, hand-verified public telnet
  BBSes (Vertrauen, Level 29, Particles!, Cave BBS, Cottonwood, Basement,
  Heatwave, Uncensored/Citadel, plus 2 known-dead listings kept in on
  purpose — dead links are part of the authentic wardialing experience).
- `server.js` — static file host + `/bridge` WebSocket endpoint. The
  **only** thing a client can send is a directory `id`; the server looks up
  the real host/port itself. It never accepts a client-supplied host/port
  — that's the line between "retro BBS dialer" and "port scanner."
- `telnet-filter.js` — strips telnet IAC negotiation bytes out of the
  stream server-side (xterm.js expects terminal output, not protocol
  bytes) and answers every WILL/DO with a blanket refusal so the BBS's
  negotiation state machine doesn't hang.
- `wardial.js` — the dial sequencer. Real outcome mapping:
  `ECONNREFUSED → BUSY`, `unreachable/DNS → NO CARRIER`,
  `connect timeout (8s) → RING — NO ANSWER`, `TCP connect succeeds → CONNECT`.
- `connect.js` / `app.js` — browser side: opens the bridge WebSocket,
  mounts an xterm.js terminal on it the instant the real connection lands
  (before playing the cosmetic handshake sound — see the comment in
  `wardial.js` about why ordering here matters).
- `audio.js` — all tones are Web Audio oscillators (real DTMF pairs, real
  US ring/busy cadences, a procedural modem sweep). No samples.
- `resources.js` / `quotes.js` — see below.

## Resources & quiet signals

Two intentionally different layers, on purpose:

- **`[H]` Help** — a permanent, un-hidden main menu item. Real, current
  support lines (988, Veterans Crisis Line, SAMHSA, NAMI, Crisis Text
  Line). This is not an easter egg and should never become one — nobody in
  real trouble should have to solve a puzzle to find it. Keep
  `resources.js` accurate; it's the one file here that actually needs to
  stay correct over time.
- **Quiet signals** (`quotes.js`) — short, ambiguous, true-for-anyone
  lines, surfaced sparingly and never blocking anything: one on the
  power-on screen each session, one in the dial log after 5 consecutive
  failed dials during a hunt (untested against real 5-in-a-row network
  failures end-to-end, since most of the seed directory actually connects
  — the render path is identical to the already-verified BUSY/NO CARRIER
  lines, just worth knowing it's logic-verified rather than fully E2E'd),
  and one on a hidden typed trigger (type `hello` or `anyone there` from
  any non-connected screen). Typing `sos` or `help` skips the ambience
  entirely and jumps straight to the real Help screen. None of this is
  reachable mid-session — typing to a live BBS is always just typing to
  the BBS.

## Known limitations (by design, for now)

- **Telnet only.** No SSH bridging yet (Uncensored/Citadel supports SSH
  too, but it's dialed here over telnet).
- **Fixed 80×24 terminal, no NAWS.** The bridge refuses all telnet options
  including window-size negotiation, so boards that adapt to terminal size
  will assume the default.
- **Directory is a hand-picked seed, not a live ingest pipeline.** Real
  ingest (scheduled scrape of a full public directory, automated
  uptime-checking) is future work.
- **Local dev server only.** `server.js` has no auth/rate-limiting; don't
  expose it publicly as-is.
