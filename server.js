// server.js — the whole Phase 1 backend: static file host + the
// WebSocket<->telnet bridge. One process, `node server.js`.
//
// Security-load-bearing property: the client never sends a host/port. It
// sends an `id` and the server looks up the real destination from its own
// copy of BBS_DIRECTORY. This is what keeps AUTODIAL a "dial a public
// directory" tool instead of an arbitrary TCP port scanner/proxy.
//
// Hardening pass (2026-08-08): this process was crash-looping in production.
// Root cause: the static file handler called decodeURIComponent(req.url)
// with no try/catch. Any request with a malformed percent-encoding (which
// vulnerability scanners send constantly against any public port 80/443
// host — it's one of the most common opportunistic probe patterns) throws
// a synchronous URIError inside the request callback. Node has no listener
// for that, so it becomes an uncaught exception and kills the whole
// process. systemd's Restart=on-failure brought it back, but rapid repeat
// crashes eventually hit systemd's default StartLimitBurst and the unit
// gave up restarting — which is why the site went fully dark instead of
// just flapping. Fixes below: safe decoding, top-level error handlers on
// both the HTTP server and the WebSocket server, process-level crash
// guards, and basic abuse limits since this endpoint has no auth.

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { TelnetFilter } = require("./telnet-filter");
const { BBS_DIRECTORY } = require("./directory.js");

const PORT = process.env.PORT || 8734;
const CONNECT_TIMEOUT_MS = 8000;

// --- abuse limits -----------------------------------------------------
// This bridge has no auth by design (it's a public novelty wardialer), so
// these are the only things standing between it and someone opening
// thousands of live outbound TCP sockets through the box.
const MAX_TOTAL_BRIDGE_CONNECTIONS = 40;   // hard cap, all clients combined
const MAX_BRIDGE_CONNECTIONS_PER_IP = 3;   // concurrent live sessions per IP
const MIN_MS_BETWEEN_DIALS_PER_IP = 1500;  // simple per-IP throttle on new dials

const bridgeConnectionsByIp = new Map(); // ip -> count
const lastDialAtByIp = new Map();        // ip -> timestamp
let totalBridgeConnections = 0;

function clientIp(req) {
  // Not behind a trusted proxy chain beyond our own nginx, and nginx is
  // configured to pass the real client IP through X-Real-IP. Fall back to
  // the socket address if that header is ever missing.
  return req.headers["x-real-ip"] || req.socket.remoteAddress || "unknown";
}

const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".mjs": "text/javascript", ".json": "application/json", ".map": "application/json",
};

const server = http.createServer((req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain", "Allow": "GET, HEAD" });
      res.end("method not allowed");
      return;
    }

    let reqPath;
    try {
      reqPath = decodeURIComponent(req.url.split("?")[0]);
    } catch {
      // Malformed percent-encoding — this is the exact input that used to
      // crash the process. Answer it like any other bad request instead.
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("bad request");
      return;
    }

    if (reqPath === "/") reqPath = "/index.html";
    const filePath = path.join(__dirname, reqPath);
    if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }

    fs.readFile(filePath, (err, data) => {
      try {
        if (err) { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
        res.end(data);
      } catch (e) {
        console.error("[http] response error:", e);
        try { res.destroy(); } catch {}
      }
    });
  } catch (e) {
    console.error("[http] request handler error:", e);
    try { res.writeHead(500); res.end("internal error"); } catch {}
  }
});

// A response/request socket can error out (client hung up mid-transfer,
// reset connection, etc). This is normal internet noise, not a bug — but
// without a listener here it's an uncaught exception that kills the process.
server.on("clientError", (err, socket) => {
  try {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } catch {}
});
server.on("error", (err) => {
  console.error("[http] server error:", err);
});

const wss = new WebSocketServer({ server, path: "/bridge" });

// Without this, any error at the WebSocketServer level (bad upgrade
// request, etc) is also an uncaught exception -> process death.
wss.on("error", (err) => {
  console.error("[bridge] wss error:", err);
});

wss.on("connection", (ws, req) => {
  const ip = clientIp(req);

  // --- rate limit / abuse guard ---
  const now = Date.now();
  const lastDial = lastDialAtByIp.get(ip) || 0;
  const perIpCount = bridgeConnectionsByIp.get(ip) || 0;

  if (totalBridgeConnections >= MAX_TOTAL_BRIDGE_CONNECTIONS) {
    safeSend(ws, { type: "error", reason: "capacity" });
    ws.close();
    return;
  }
  if (perIpCount >= MAX_BRIDGE_CONNECTIONS_PER_IP) {
    safeSend(ws, { type: "error", reason: "too-many-sessions" });
    ws.close();
    return;
  }
  if (now - lastDial < MIN_MS_BETWEEN_DIALS_PER_IP) {
    safeSend(ws, { type: "error", reason: "rate-limited" });
    ws.close();
    return;
  }
  lastDialAtByIp.set(ip, now);

  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    safeSend(ws, { type: "error", reason: "bad-request" });
    ws.close();
    return;
  }
  const id = url.searchParams.get("id");
  const entry = BBS_DIRECTORY.find((e) => e.id === id);

  if (!entry) {
    ws.send(JSON.stringify({ type: "error", reason: "unknown-id" }));
    ws.close();
    return;
  }

  // book-keeping for the guards above
  totalBridgeConnections++;
  bridgeConnectionsByIp.set(ip, perIpCount + 1);
  let counted = true;
  function uncount() {
    if (!counted) return;
    counted = false;
    totalBridgeConnections--;
    const c = (bridgeConnectionsByIp.get(ip) || 1) - 1;
    if (c <= 0) bridgeConnectionsByIp.delete(ip);
    else bridgeConnectionsByIp.set(ip, c);
  }

  console.log(`[bridge] dialing ${entry.name} (${entry.host}:${entry.port}) for ${ip}`);

  const socket = new net.Socket();
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    socket.destroy();
    safeSend(ws, { type: "timeout" });
    ws.close();
  }, CONNECT_TIMEOUT_MS);

  const filter = new TelnetFilter(
    (clean) => { if (ws.readyState === ws.OPEN) ws.send(clean); },
    (reply) => { if (socket.writable) socket.write(reply); },
  );

  socket.connect(entry.port, entry.host, () => {
    if (settled) return; // timed out right at the wire — don't double-resolve
    settled = true;
    clearTimeout(timer);
    safeSend(ws, { type: "connected" });
  });

  socket.on("data", (chunk) => {
    try {
      filter.push(chunk);
    } catch (e) {
      // Defense in depth: the filter is a pure byte state machine and
      // shouldn't throw, but a live BBS is fully adversarial input and
      // this bridge stays up for everyone else even if one session's
      // stream does something unexpected.
      console.error("[bridge] telnet filter error:", e);
      safeSend(ws, { type: "dropped" });
      try { ws.close(); } catch {}
      try { socket.destroy(); } catch {}
    }
  });

  socket.on("error", (err) => {
    if (settled) {
      // connection was already live and dropped mid-session
      safeSend(ws, { type: "dropped" });
      ws.close();
      return;
    }
    settled = true;
    clearTimeout(timer);
    const reason = err.code === "ECONNREFUSED" ? "refused" : "unreachable";
    safeSend(ws, { type: reason });
    ws.close();
  });

  socket.on("close", () => {
    if (settled) { safeSend(ws, { type: "dropped" }); }
    if (ws.readyState === ws.OPEN) ws.close();
  });

  ws.on("message", (data, isBinary) => {
    if (!isBinary) return; // control frames only ever flow server->client
    if (socket.writable) socket.write(data);
  });

  ws.on("error", (err) => {
    // A per-connection error listener is required — without one, a bad
    // frame from a hostile/broken client would be another uncaught
    // exception -> process death.
    console.error(`[bridge] ws error for ${ip}:`, err.message);
  });

  ws.on("close", () => {
    clearTimeout(timer);
    socket.destroy();
    uncount();
  });
});

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// --- process-level crash guards ---------------------------------------
// Last line of defense. Anything that reaches here means a bug slipped
// past the handlers above; log it with enough detail to fix, then exit
// so systemd restarts us into a clean state rather than limping along in
// a possibly-corrupt one. journalctl -u autodial will have the trace.
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection:", reason);
  process.exit(1);
});

// Graceful shutdown so `systemctl restart` / redeploys don't just yank
// live sessions out from under anyone mid-BBS-session.
function shutdown(signal) {
  console.log(`[server] received ${signal}, shutting down`);
  wss.clients.forEach((ws) => { try { ws.close(1001, "server restarting"); } catch {} });
  server.close(() => process.exit(0));
  // don't hang forever waiting for slow clients
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, () => {
  console.log(`AUTODIAL.EXE bridge listening on http://localhost:${PORT}`);
  console.log(`Directory: ${BBS_DIRECTORY.length} entries (${BBS_DIRECTORY.filter(e => e.status === "up").length} last seen up)`);
});
