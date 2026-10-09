// Terminal compose-buffer logic — send-net-resilience slice 4b.
//
// Pure-logic pins for web/src/lib/termCompose.ts: while the terminal pane's
// private ws is down (or suspected half-open), typed TEXT routes into a
// visible, editable compose buffer shown as NOT SENT; it is NEVER written to
// the PTY/ws except through an explicit user send (debate-2 Q4 is binding:
// queue-and-replay of raw PTY input means later blind execution of stale
// keystrokes — worse than loss). Control-sequence gestures (ESC/TAB/arrows/
// Ctrl+letter, ^C) are NOT buffered: they are not reviewable text, and
// deferring them for later execution is exactly the prohibited replay hazard.
// The buffering STATE itself (badge + strip) is the honest "not going
// anywhere" surface for gestures.

import { describe, expect, it } from "vitest";
import {
  TERM_STALE_MS,
  classifyTermInput,
  composeStripVisible,
  isStaleInput,
  loadTermCompose,
  saveTermCompose,
  toComposeText,
  toWireText,
} from "../../src/lib/termCompose";

describe("termCompose — input classification", () => {
  it("classifies printable text (incl. spaces, punctuation, CJK, emoji) as text", () => {
    expect(classifyTermInput("a")).toBe("text");
    expect(classifyTermInput("echo HELD_123 | ~")).toBe("text");
    expect(classifyTermInput("日本語テキスト")).toBe("text");
    expect(classifyTermInput("emoji 👍 ok")).toBe("text");
    expect(classifyTermInput(" ")).toBe("text"); // space is 0x20 — printable
  });

  it("classifies newlines (\\r, \\n) as text — Enter offline must be held visibly", () => {
    expect(classifyTermInput("\r")).toBe("text");
    expect(classifyTermInput("\n")).toBe("text");
    expect(classifyTermInput("cmd one\ncmd two")).toBe("text");
  });

  it("classifies control sequences as gestures — never buffered, never replayed", () => {
    expect(classifyTermInput("\x1b")).toBe("gesture"); // esc
    expect(classifyTermInput("\t")).toBe("gesture"); // tab
    expect(classifyTermInput("\x03")).toBe("gesture"); // ^C
    expect(classifyTermInput("\x1b[A")).toBe("gesture"); // arrow up
    expect(classifyTermInput("\x1bOA")).toBe("gesture"); // arrow up, DECCKM
    expect(classifyTermInput("a\x1b")).toBe("gesture"); // mixed paste → not reviewable text
    expect(classifyTermInput("\x7f")).toBe("gesture"); // DEL
    expect(classifyTermInput("")).toBe("gesture"); // nothing to hold
  });
});

describe("termCompose — display/wire text mapping", () => {
  it("toComposeText maps CR (and CRLF) to LF for the visible buffer", () => {
    expect(toComposeText("echo hi\r")).toBe("echo hi\n");
    expect(toComposeText("a\r\nb\r")).toBe("a\nb\n");
    expect(toComposeText("plain")).toBe("plain");
  });

  it("toWireText maps LF back to CR for the PTY (round-trips compose text)", () => {
    expect(toWireText("echo hi\n")).toBe("echo hi\r");
    expect(toWireText(toComposeText("a\r\nb\r"))).toBe("a\rb\r");
  });
});

describe("termCompose — half-open staleness threshold", () => {
  it("fires only past TERM_STALE_MS while open (2 missed 15s keepalives + slack)", () => {
    const t0 = 1_000_000;
    expect(isStaleInput(true, t0, t0 + TERM_STALE_MS - 1)).toBe(false);
    expect(isStaleInput(true, t0, t0 + TERM_STALE_MS + 1)).toBe(true);
  });

  it("never fires while not open, or without a lastRecv baseline", () => {
    expect(isStaleInput(false, 1_000_000, 1_000_000 + TERM_STALE_MS + 60_000)).toBe(false);
    expect(isStaleInput(true, 0, 1_000_000)).toBe(false);
  });

  it("stays below the pane's 45s liveness force-reconnect so input is held BEFORE the teardown", () => {
    expect(TERM_STALE_MS).toBeLessThan(45_000);
  });
});

describe("termCompose — strip visibility", () => {
  it("hidden while connected with nothing buffered (zero friction on the live path)", () => {
    expect(composeStripVisible(false, "open", false)).toBe(false);
  });

  it("visible whenever text is held — even while connected (holds until explicit send)", () => {
    expect(composeStripVisible(true, "open", false)).toBe(true);
    expect(composeStripVisible(true, "connecting", false)).toBe(true);
    expect(composeStripVisible(true, "reconnecting", false)).toBe(true);
    expect(composeStripVisible(true, "disconnected", false)).toBe(true);
  });

  it("visible (empty) as a held affordance whenever input would be buffered — except initial connect", () => {
    expect(composeStripVisible(false, "reconnecting", false)).toBe(true);
    expect(composeStripVisible(false, "disconnected", false)).toBe(true);
    expect(composeStripVisible(false, "open", true)).toBe(true); // half-open stale
    expect(composeStripVisible(false, "connecting", false)).toBe(false); // first open: no noise
  });
});

describe("termCompose — buffer store survives pane remounts", () => {
  it("saves and loads per (dir, termId) key", () => {
    saveTermCompose("/repo", "shared", "held text");
    expect(loadTermCompose("/repo", "shared")).toBe("held text");
    expect(loadTermCompose("/repo", "other")).toBe("");
    expect(loadTermCompose("/elsewhere", "shared")).toBe("");
  });

  it("default id mirrors the pane/server default ('shared')", () => {
    saveTermCompose("/repo2", undefined, "no-id text");
    expect(loadTermCompose("/repo2", undefined)).toBe("no-id text");
    expect(loadTermCompose("/repo2", "shared")).toBe("no-id text");
  });

  it("saving empty clears the entry (no unbounded map growth)", () => {
    saveTermCompose("/repo3", "t1", "x");
    saveTermCompose("/repo3", "t1", "");
    expect(loadTermCompose("/repo3", "t1")).toBe("");
  });
});
