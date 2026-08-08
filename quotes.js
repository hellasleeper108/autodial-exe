// quotes.js — quiet, ambiguous, true regardless of who's reading them.
// Surfaced sparingly: one per boot, one after a run of failed dials, one on
// a hidden typed trigger. Never blocks anything, never demands a response.

const QUIET_SIGNALS = [
  "still here. that's not nothing.",
  "the line was busy, not gone. try again tomorrow.",
  "every board on this list went dark at least once. some came back.",
  "nobody logs on alone forever.",
  "pain doesn't end when you disconnect. it gets routed to whoever loved you — and it doesn't stop there.",
  "you are not the first caller tonight, and you won't be the last.",
  "static isn't silence. someone's still on the line.",
  "systems go down. sysops bring them back up. so do people.",
  "if nobody's picked up yet, it doesn't mean nobody will.",
  "the network remembers every board that ever came back online.",
  "hang up if you need to. dial again when you're ready. no penalty for either.",
  "built by someone who's been off the air before, and came back anyway.",
];

function randomSignal() {
  return QUIET_SIGNALS[Math.floor(Math.random() * QUIET_SIGNALS.length)];
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { QUIET_SIGNALS, randomSignal };
} else {
  window.QUIET_SIGNALS = QUIET_SIGNALS;
  window.randomSignal = randomSignal;
}
