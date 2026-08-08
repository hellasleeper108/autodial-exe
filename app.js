// app.js — screen state machine, rendering, keyboard wiring, persistence.
// Phase 1: the dial is still theater (audio/pacing), but the destination is
// real — wardial.js's attempt() now drives a live TCP probe via connect.js,
// and a CONNECT hands back a real WebSocket that gets attached to an
// xterm.js terminal here.

const LOG_KEY = "autodial_calllog_v1";
const SCOPES = ["all", ...new Set(BBS_DIRECTORY.map((e) => e.software))];

const audio = new AudioEngine();
const sequencer = new WardialSequencer(audio);

const state = {
  mode: "menu",       // menu | wardial | directory | connected | log | settings | resources
  realism: "standard",
  scope: "all",
  muted: false,
  hunting: false,
  huntToken: 0,
  pool: [],
  poolIndex: 0,
  dirIndex: 0,
  returnMode: "wardial",
  consecutiveFails: 0,
  lines: [],
  currentLine: null,
  activeConnection: null, // {entry, ws, baud, connectedAt}
  connectTimer: null,
  term: null,
  termHandle: null,
};

const $ = (id) => document.getElementById(id);

// ---------- persistence ----------
function loadLog() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY)) || []; }
  catch { return []; }
}
function saveLogEntry(entry) {
  const log = loadLog();
  log.unshift(entry);
  localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(0, 500)));
}

// ---------- power gate ----------
function powerOn() {
  audio.ensure();
  $("power-gate").classList.add("hidden");
  $("app").classList.remove("hidden");
  buildPool();
  render();
  window.removeEventListener("keydown", powerOnHandler);
  document.removeEventListener("click", powerOnHandler);
}
function powerOnHandler() { powerOn(); }
window.addEventListener("keydown", powerOnHandler, { once: true });
document.addEventListener("click", powerOnHandler, { once: true });

const signalEl = $("power-signal");
if (signalEl) signalEl.textContent = "SIGNAL: " + randomSignal();

// ---------- pool management (wardial mode) ----------
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function buildPool() {
  const filtered = state.scope === "all"
    ? BBS_DIRECTORY
    : BBS_DIRECTORY.filter((e) => e.software === state.scope);
  state.pool = shuffled(filtered.length ? filtered : BBS_DIRECTORY);
  state.poolIndex = 0;
}
function nextEntry() {
  if (state.poolIndex >= state.pool.length) buildPool();
  return state.pool[state.poolIndex++];
}

// ---------- status bar ----------
function updateStatusBar() {
  const left = {
    menu: "COM1 · IDLE", wardial: state.hunting ? "COM1 · HUNTING" : "COM1 · IDLE",
    directory: "COM1 · IDLE", connected: "COM1 · CARRIER",
    log: "COM1 · IDLE", settings: "COM1 · IDLE", resources: "COM1 · IDLE",
  }[state.mode];
  $("sb-left").textContent = left;
  $("sb-snd").textContent = state.muted ? "OFF" : "ON";
  const mid = $("sb-mid");
  if (state.mode === "connected" && state.activeConnection) {
    const secs = Math.floor((Date.now() - state.activeConnection.connectedAt) / 1000);
    const m = String(Math.floor(secs / 60)).padStart(2, "0");
    const s = String(secs % 60).padStart(2, "0");
    mid.textContent = `${state.activeConnection.entry.name} · 00:${m}:${s}`;
  } else {
    mid.textContent = "";
  }
}

// ---------- rendering ----------
function render() {
  const body = $("body");
  if (state.mode === "menu") body.innerHTML = renderMenu();
  else if (state.mode === "wardial") body.innerHTML = renderWardial();
  else if (state.mode === "directory") body.innerHTML = renderDirectory();
  else if (state.mode === "connected") body.innerHTML = renderConnectedShell();
  else if (state.mode === "log") body.innerHTML = renderLog();
  else if (state.mode === "settings") body.innerHTML = renderSettings();
  else if (state.mode === "resources") body.innerHTML = renderResources();
  wireBodyEvents();
  renderHints();
  updateStatusBar();
}

function renderMenu() {
  const log = loadLog();
  const connects = log.filter((l) => l.result.startsWith("CONNECT")).length;
  const up = BBS_DIRECTORY.filter((e) => e.status === "up").length;
  return `
    <div class="menu-title">MAIN MENU</div>
    <div class="menu-item" data-action="wardial"><b>[W]</b> Wardial — let the machine hunt</div>
    <div class="menu-item" data-action="directory"><b>[D]</b> Directory — browse &amp; dial by name</div>
    <div class="menu-item" data-action="log"><b>[L]</b> Call Log — ${log.length} attempts, ${connects} connects</div>
    <div class="menu-item" data-action="settings"><b>[S]</b> Settings — realism, scope, sound</div>
    <div class="menu-item" data-action="resources"><b>[H]</b> Help — real support lines, no strings attached</div>
    <div class="menu-sub">directory: ${BBS_DIRECTORY.length} real systems (${up} last seen up) — bridge live on this server</div>
  `;
}

function renderWardial() {
  const lines = state.lines.slice(-14).join("");
  return `
    <div class="dial-controls">
      <button data-action="toggle-hunt" class="${state.hunting ? "active" : ""}">${state.hunting ? "■ STOP" : "▶ DIAL"}</button>
      <span>realism:</span>
      <select data-action="set-realism">
        ${Object.entries(REALISM_PRESETS).map(([k, v]) =>
          `<option value="${k}" ${k === state.realism ? "selected" : ""}>${v.label}</option>`).join("")}
      </select>
      <span>scope:</span>
      <select data-action="set-scope">
        ${SCOPES.map((s) => `<option value="${s}" ${s === state.scope ? "selected" : ""}>${s}</option>`).join("")}
      </select>
      <button data-action="toggle-mute">${state.muted ? "SOUND OFF" : "SOUND ON"}</button>
    </div>
    <div class="log-scroll" id="log-scroll">${lines || '<span class="dim">press DIAL to start hunting real systems…</span>'}</div>
  `;
}

function renderDirectory() {
  const rows = BBS_DIRECTORY.map((e, i) => {
    const sel = i === state.dirIndex ? "active" : "";
    const statusHtml = e.status === "up"
      ? '<span class="green">● up</span>'
      : '<span class="red">● last check: dead</span>';
    return `<div class="menu-item ${sel}" data-action="dial-entry" data-id="${e.id}">
      ${e.name.padEnd(20)} <span class="dim">${e.software.padEnd(11)}</span> ${statusHtml}
    </div>`;
  }).join("");
  return `
    <div class="menu-title">DIRECTORY — ${BBS_DIRECTORY.length} REAL SYSTEMS</div>
    ${rows}
    <div class="menu-sub">status shown is last hand-check (${BBS_DIRECTORY[0].verified}) — every dial re-checks live</div>
  `;
}

function renderConnectedShell() {
  const c = state.activeConnection;
  return `
    <div class="connected-meta">CONNECT ${c.baud} · ${c.number} · ${c.entry.name} · ${c.entry.host}:${c.entry.port}</div>
    <div id="xterm-mount" class="xterm-mount"></div>
    <div class="dim" style="margin-top:8px;">press ESC to hang up (ATH0)</div>
  `;
}

function renderLog() {
  const log = loadLog();
  const connects = log.filter((l) => l.result.startsWith("CONNECT")).length;
  const rows = log.slice(0, 60).map((l) => {
    const cls = l.result.startsWith("CONNECT") ? "green" : l.result === "BUSY" ? "bright" : "red";
    const d = new Date(l.ts);
    const ts = `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return `<tr><td>${ts}</td><td>${l.number}</td><td class="bright">${l.name}</td><td class="${cls}">${l.result}</td></tr>`;
  }).join("");
  return `
    <div class="stat-row">
      <div><b>${log.length}</b>attempts</div>
      <div><b>${connects}</b>connects</div>
      <div><b>${log.length ? Math.round((connects / log.length) * 100) : 0}%</b>hit rate</div>
    </div>
    <table>
      <thead><tr><th>Date</th><th>Number</th><th>System</th><th>Result</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="dim">no attempts logged yet</td></tr>`}</tbody>
    </table>
  `;
}

function renderSettings() {
  return `
    <div class="menu-title">SETTINGS</div>
    <div class="dial-controls" style="margin-bottom:24px;">
      <span>realism:</span>
      <select data-action="set-realism">
        ${Object.entries(REALISM_PRESETS).map(([k, v]) =>
          `<option value="${k}" ${k === state.realism ? "selected" : ""}>${v.label}</option>`).join("")}
      </select>
    </div>
    <div class="dial-controls" style="margin-bottom:24px;">
      <span>scope filter:</span>
      <select data-action="set-scope">
        ${SCOPES.map((s) => `<option value="${s}" ${s === state.scope ? "selected" : ""}>${s}</option>`).join("")}
      </select>
    </div>
    <div class="dial-controls">
      <button data-action="toggle-mute">${state.muted ? "SOUND: OFF" : "SOUND: ON"}</button>
    </div>
  `;
}

function renderResources() {
  const blocks = RESOURCES.map((block) => `
    <div class="res-block">
      <div class="res-category">${block.category}</div>
      ${block.items.map((it) => `<div class="res-item"><span class="res-label">${it.label}</span><span class="res-detail">${it.detail}</span></div>`).join("")}
    </div>
  `).join("");
  return `
    <div class="menu-title">HELP</div>
    ${blocks}
    <div class="res-note">these are real numbers. this menu item isn't hidden and never will be — you shouldn't have to hunt for it.</div>
  `;
}

function renderHints() {
  const hints = {
    menu: "<b>W</b> wardial   <b>D</b> directory   <b>L</b> log   <b>S</b> settings   <b>H</b> help",
    wardial: "<b>SPACE</b> dial/stop   <b>M</b> mute   <b>ESC</b> back to menu",
    directory: "<b>↑↓</b> select   <b>ENTER</b> dial   <b>ESC</b> back to menu",
    connected: "<b>ESC</b> hang up",
    log: "<b>ESC</b> back to menu",
    settings: "<b>ESC</b> back to menu",
    resources: "<b>ESC</b> back to menu",
  };
  $("hintbar").innerHTML = hints[state.mode] || "";
}

function wireBodyEvents() {
  document.querySelectorAll("[data-action]").forEach((el) => {
    const action = el.dataset.action;
    if (el.tagName === "SELECT") {
      el.addEventListener("change", (e) => {
        if (action === "set-realism") state.realism = e.target.value;
        if (action === "set-scope") { state.scope = e.target.value; buildPool(); }
      });
    } else if (action === "dial-entry") {
      el.addEventListener("click", () => {
        const entry = BBS_DIRECTORY.find((x) => x.id === el.dataset.id);
        if (entry) dialSpecific(entry);
      });
    } else {
      el.addEventListener("click", () => handleAction(action));
    }
  });
}

function handleAction(action) {
  if (action === "wardial") goTo("wardial");
  else if (action === "directory") goTo("directory");
  else if (action === "log") goTo("log");
  else if (action === "settings") goTo("settings");
  else if (action === "resources") goTo("resources");
  else if (action === "toggle-hunt") toggleHunt();
  else if (action === "toggle-mute") { state.muted = !state.muted; audio.setMuted(state.muted); render(); }
}

function goTo(mode) {
  state.mode = mode;
  render();
}

// ---------- the hunt loop (wardial mode) ----------
function toggleHunt() {
  if (state.hunting) stopHunt();
  else startHunt();
}
function startHunt() {
  state.hunting = true;
  state.huntToken++;
  const myToken = state.huntToken;
  render();
  huntLoop(myToken);
}
function stopHunt() {
  state.hunting = false;
  sequencer.stop();
  render();
}

async function huntLoop(myToken) {
  const preset = REALISM_PRESETS[state.realism];
  while (state.hunting && myToken === state.huntToken) {
    const entry = nextEntry();
    startLine();
    const result = await sequencer.attempt(entry, state.realism, onDialEvent);
    if (myToken !== state.huntToken) return;
    if (result.result === "aborted") return;

    saveLogEntry({ ts: Date.now(), number: result.number, name: entry.name, result: result.result });

    if (result.result.startsWith("CONNECT")) {
      // terminal is already mounted — wardial.js fired 'connect' before
      // awaiting the handshake sound, and onDialEvent calls showConnected().
      state.hunting = false;
      state.returnMode = "wardial";
      state.consecutiveFails = 0;
      return;
    }

    state.consecutiveFails++;
    if (state.consecutiveFails >= 5) {
      state.consecutiveFails = 0;
      state.lines.push(`<div class="log-line signal-line">${randomSignal()}</div>`);
    }
    render();
    await sleep(700 / preset.speed);
  }
}

// ---------- directory mode: dial one specific board ----------
let dialing = false;
async function dialSpecific(entry) {
  if (dialing || state.hunting) return;
  dialing = true;
  state.returnMode = "directory";
  state.mode = "wardial";
  render();
  startLine();
  const result = await sequencer.attempt(entry, state.realism, onDialEvent);
  dialing = false;
  if (result.result === "aborted") { render(); return; }
  saveLogEntry({ ts: Date.now(), number: result.number, name: entry.name, result: result.result });
  if (!result.result.startsWith("CONNECT")) render(); // else: already mounted via onDialEvent's 'connect' stage
}

// ---------- connected screen: real xterm session over the bridge ----------
function showConnected(entry, result) {
  state.activeConnection = { entry, ws: result.ws, baud: result.baud, connectedAt: Date.now(), number: result.number };
  state.mode = "connected";
  render();

  const term = new Terminal({
    cols: 80,
    rows: 24,
    fontFamily: "ui-monospace, Menlo, Consolas, monospace",
    fontSize: 14,
    cursorBlink: true,
    scrollback: 2000,
    theme: {
      background: "#0b0904", foreground: "#ffb100", cursor: "#ffd876",
      selectionBackground: "#4a3707",
    },
  });
  term.open($("xterm-mount"));
  term.focus();
  // xterm owns keyboard focus once connected, so its hidden input element
  // sees Escape before the window-level hotkey listener ever would — hook
  // in here so ESC always hangs up instead of being sent to the BBS as data.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === "keydown" && e.key === "Escape") {
      hangUp("user");
      return false;
    }
    return true;
  });
  state.term = term;
  state.termHandle = attachTerminal(result.ws, term, (reason) => hangUp(reason === "user" ? "user" : "dropped"));

  state.connectTimer = setInterval(updateStatusBar, 1000);
}

function hangUp(reason = "user") {
  if (!state.activeConnection) return;
  audio.hangupStatic();
  clearInterval(state.connectTimer);
  state.termHandle?.dispose();
  state.term = null;
  state.termHandle = null;

  const entry = state.activeConnection.entry;
  const number = state.activeConnection.number;
  state.activeConnection = null;
  saveLogEntry({
    ts: Date.now(), number, name: entry.name,
    result: reason === "user" ? "HUNG UP" : "NO CARRIER (dropped)",
  });
  goTo(state.returnMode || "wardial");
}

function startLine() { state.currentLine = { html: "" }; }
function pushSeg(html) {
  if (!state.currentLine) startLine();
  state.currentLine.html += html;
  if (state.mode === "wardial") {
    const scroll = $("log-scroll");
    if (scroll) {
      scroll.innerHTML = state.lines.slice(-14).join("") + `<div class="log-line">${state.currentLine.html}</div>`;
      scroll.scrollTop = scroll.scrollHeight;
    }
  }
}
function finishLine() {
  if (state.currentLine) {
    state.lines.push(`<div class="log-line">${state.currentLine.html}</div>`);
    state.currentLine = null;
  }
}

function onDialEvent(stage, data) {
  if (stage === "dialing") {
    pushSeg(`${data.number} ....... dialing <span class="dim">`);
  } else if (stage === "digit") {
    pushSeg("tone ");
  } else if (stage === "busy") {
    pushSeg(`</span>... <span class="red">BUSY</span>`);
    finishLine();
  } else if (stage === "ringing") {
    pushSeg(`</span>ring ring <span class="dim">`);
  } else if (stage === "no-answer") {
    pushSeg(`</span>... <span class="red">RING — NO ANSWER</span>`);
    finishLine();
  } else if (stage === "no-carrier") {
    pushSeg(`</span>... <span class="red">NO CARRIER</span>`);
    finishLine();
  } else if (stage === "handshake") {
    pushSeg(`</span>... <span class="green">CONNECT ${data.baud}</span>`);
    finishLine();
    state.lines.push(`<div class="log-line"><span class="cyan">→ carrier detected: negotiating...</span></div>`);
  } else if (stage === "connect") {
    showConnected(data.entry, data);
  }
}

// ---------- hidden typed-word triggers ----------
// Never active mid-session (see the early return below) — typing to a real
// BBS should always just be typing to the BBS. "sos"/"help" jump straight
// to the real resources screen; the others are just a quiet acknowledgment.
let toastTimer = null;
function showToast(text, ms = 4500) {
  let el = $("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    $("screen").appendChild(el);
  }
  el.textContent = text;
  requestAnimationFrame(() => el.classList.add("visible"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), ms);
}

const DIRECT_HELP_WORDS = ["sos", "help"];
const QUIET_WORDS = ["hello", "anyone there", "anybody there"];
let typedBuffer = "";
function trackTypedWord(key) {
  if (key.length !== 1 || !/[a-z ]/i.test(key)) return;
  typedBuffer = (typedBuffer + key.toLowerCase()).slice(-24);
  for (const w of DIRECT_HELP_WORDS) {
    if (typedBuffer.endsWith(w)) { typedBuffer = ""; goTo("resources"); return; }
  }
  for (const w of QUIET_WORDS) {
    if (typedBuffer.endsWith(w)) { typedBuffer = ""; showToast(randomSignal() + "   — [H] for real help, anytime"); return; }
  }
}

// ---------- keyboard ----------
window.addEventListener("keydown", (e) => {
  if ($("power-gate") && !$("power-gate").classList.contains("hidden")) return;
  const k = e.key.toLowerCase();

  if (state.mode === "connected") {
    if (k === "escape") hangUp("user");
    return; // don't let hotkeys — or the hidden triggers — leak into a live terminal session
  }

  trackTypedWord(e.key);

  if (state.mode === "menu") {
    if (k === "w") goTo("wardial");
    else if (k === "d") { state.dirIndex = 0; goTo("directory"); }
    else if (k === "l") goTo("log");
    else if (k === "s") goTo("settings");
    else if (k === "h") goTo("resources");
  } else if (state.mode === "wardial") {
    if (k === " " || k === "enter") { e.preventDefault(); toggleHunt(); }
    else if (k === "m") { state.muted = !state.muted; audio.setMuted(state.muted); render(); }
    else if (k === "escape") { stopHunt(); goTo("menu"); }
  } else if (state.mode === "directory") {
    if (k === "arrowdown") { state.dirIndex = Math.min(BBS_DIRECTORY.length - 1, state.dirIndex + 1); render(); }
    else if (k === "arrowup") { state.dirIndex = Math.max(0, state.dirIndex - 1); render(); }
    else if (k === "enter") dialSpecific(BBS_DIRECTORY[state.dirIndex]);
    else if (k === "escape") goTo("menu");
  } else if (state.mode === "log" || state.mode === "settings" || state.mode === "resources") {
    if (k === "escape") goTo("menu");
    if (state.mode === "settings" && k === "m") { state.muted = !state.muted; audio.setMuted(state.muted); render(); }
  }
});
