// directory.js — the BBS directory. Phase 1: real entries, sourced from
// public listings (Telnet BBS Guide + community "BBSes you can telnet to"
// threads) and each one hand-verified with a live TCP probe + banner read
// on 2026-08-06. `status` below is that one-time snapshot for the Directory
// screen's "last checked" display only — every actual dial (wardial or
// direct) re-probes the real host live, it never trusts this cached value.
//
// Real ingest (scheduled scrape/refresh of a full directory, automated
// health-checking) is future work — see the design spec, §7.
//
// `id` is the allow-list key used by server.js: the bridge only ever
// connects to a host:port that's in this exact list, never to anything a
// client sends directly.

const BBS_DIRECTORY = [
  { id: "vertrauen",   name: "Vertrauen",        host: "vert.synchro.net",          port: 23,   software: "Synchronet", region: "—remote—", status: "up",   verified: "2026-08-06" },
  { id: "level29",     name: "Level 29 BBS",     host: "bbs.fozztexx.com",          port: 23,   software: "Custom",     region: "—remote—", status: "up",   verified: "2026-08-06" },
  { id: "particles",   name: "Particles! BBS",   host: "particlesbbs.dyndns.org",   port: 6400, software: "Custom",     region: "—remote—", status: "up",   verified: "2026-08-06" },
  { id: "cavebbs",     name: "The Cave BBS",     host: "cavebbs.homeip.net",        port: 23,   software: "Synchronet", region: "—remote—", status: "up",   verified: "2026-08-06" },
  { id: "cottonwood",  name: "Cottonwood BBS",   host: "cottonwoodbbs.dyndns.org",  port: 6502, software: "Custom",     region: "—remote—", status: "up",   verified: "2026-08-06" },
  { id: "basement",    name: "The Basement BBS", host: "basementbbs.ddns.net",      port: 9000, software: "Custom",     region: "—remote—", status: "up",   verified: "2026-08-06" },
  { id: "heatwave",    name: "Heatwave BBS",     host: "heatwave.ddns.net",         port: 9640, software: "Custom",     region: "—remote—", status: "up",   verified: "2026-08-06" },
  { id: "uncensored",  name: "Uncensored",       host: "uncensored.citadel.org",    port: 23,   software: "Citadel",    region: "—remote—", status: "up",   verified: "2026-08-06" },
  { id: "darkforce",   name: "Dark Force BBS",   host: "darkforce-bbs.dyndns.org",  port: 520,  software: "Unknown",    region: "—remote—", status: "dead", verified: "2026-08-06" },
  { id: "madworld",    name: "Mad World BBS",    host: "madworld.bounceme.net",     port: 6400, software: "Unknown",    region: "—remote—", status: "dead", verified: "2026-08-06" },
];

// deterministic-ish fake phone number derived from the entry's id, so a
// given board always "dials" the same number across a session.
function syntheticNumber(entry) {
  let h = 0;
  for (const ch of entry.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const exch = 550 + (h % 50);
  const line = h % 10000;
  return `${exch}-${String(line).padStart(4, "0")}`;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { BBS_DIRECTORY, syntheticNumber };
} else {
  window.BBS_DIRECTORY = BBS_DIRECTORY;
  window.syntheticNumber = syntheticNumber;
}
