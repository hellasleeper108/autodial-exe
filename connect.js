// connect.js — browser side of the bridge protocol.
//
// Protocol: client opens ws://host/bridge?id=<entry.id> (never a raw
// host/port — see server.js). First frame back is always a JSON text
// control message: {type: "connected"} | {type:"refused"|"unreachable"|"timeout"}.
// After "connected", every further frame is raw binary telnet-output bytes
// (already stripped of IAC by the server) until the socket closes.

function dialReal(entry, { timeoutMs = 8500, signal } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/bridge?id=${entry.id}`);
    ws.binaryType = "arraybuffer";

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(clientTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = () => { ws.close(); finish({ status: "aborted" }); };
    signal?.addEventListener("abort", onAbort);

    const clientTimer = setTimeout(() => {
      ws.close();
      finish({ status: "timeout" });
    }, timeoutMs + 1500); // slightly after the server's own timeout, as a fallback

    ws.onmessage = (ev) => {
      if (settled) return; // shouldn't get here pre-resolve, but guard anyway
      if (typeof ev.data !== "string") return;
      const msg = JSON.parse(ev.data);
      if (msg.type === "connected") finish({ status: "connected", ws });
      else finish({ status: msg.type }); // refused | unreachable | timeout | error
    };

    ws.onerror = () => finish({ status: "unreachable" });
  });
}

// Wires an already-"connected" bridge socket to an xterm.js Terminal.
// Calls onClose(reason) once, whenever the session ends.
function attachTerminal(ws, term, onClose) {
  term.clear();
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      const msg = JSON.parse(ev.data);
      if (msg.type === "dropped") { onClose("dropped"); }
      return;
    }
    term.write(new Uint8Array(ev.data));
  };
  ws.onclose = () => onClose("closed");
  ws.onerror = () => onClose("closed");
  const dataSub = term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
  });
  return { dispose: () => { dataSub.dispose(); ws.close(); } };
}

window.dialReal = dialReal;
window.attachTerminal = attachTerminal;
