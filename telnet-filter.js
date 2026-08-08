// telnet-filter.js — minimal stateful telnet IAC (RFC 854) stripper.
//
// BBSes speak raw telnet, which interleaves protocol negotiation bytes
// (IAC + command [+ option]) into the same stream as the actual terminal
// output. xterm.js only understands terminal output (text + ANSI/VT
// escapes) — if IAC bytes reach it unfiltered they render as garbage
// characters. This strips every negotiation sequence out of the
// server->client stream and answers each one with a blanket refusal
// (WONT/DONT) so the remote side's negotiation state machine doesn't hang
// waiting for a reply. It does not attempt to actually support any telnet
// option (echo, terminal type, NAWS, ...) — refusing everything is a
// deliberate minimal-viable choice; see README for the known limitation.

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;

class TelnetFilter {
  constructor(onClean, onReply) {
    this.onClean = onClean; // (Buffer) => void — filtered bytes bound for the terminal
    this.onReply = onReply; // (Buffer) => void — negotiation replies bound back to the BBS
    this.state = "data";    // data | iac | cmd | sub
    this.cleanChunks = [];
  }

  push(chunk) {
    this.cleanChunks = [];
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      if (this.state === "data") {
        if (b === IAC) this.state = "iac";
        else this.cleanChunks.push(b);
      } else if (this.state === "iac") {
        if (b === IAC) { this.cleanChunks.push(IAC); this.state = "data"; } // escaped 0xFF
        else if (b === SB) this.state = "sub";
        else if (b === WILL || b === WONT || b === DO || b === DONT) {
          this._pendingCmd = b;
          this.state = "cmd";
        } else {
          this.state = "data"; // NOP/GA/etc — single-byte command, nothing to reply
        }
      } else if (this.state === "cmd") {
        const option = b;
        if (this._pendingCmd === WILL || this._pendingCmd === DO) {
          // refuse whatever's offered/requested
          const reply = this._pendingCmd === WILL ? DONT : WONT;
          this.onReply(Buffer.from([IAC, reply, option]));
        }
        this.state = "data";
      } else if (this.state === "sub") {
        // skip subnegotiation payload until IAC SE
        if (b === IAC) this.state = "sub-iac";
      } else if (this.state === "sub-iac") {
        if (b === SE) this.state = "data";
        else this.state = "sub"; // false alarm, keep skipping
      }
    }
    if (this.cleanChunks.length) this.onClean(Buffer.from(this.cleanChunks));
  }
}

module.exports = { TelnetFilter };
