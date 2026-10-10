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

import { describe, expect, it, vi } from "vitest";
import {
  TERM_STALE_MS,
  classifyTermInput,
  composeStripVisible,
  disposeTermCompose,
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

  it("saving empty on a never-seen key is a no-op", () => {
    saveTermCompose("/never", "t9", "");
    expect(loadTermCompose("/never", "t9")).toBe("");
  });
});

describe("termCompose — disposal on shell death (D-4b-3 + d-F5)", () => {
  it("disposeTermCompose deletes the matching (dir, termId) entry", () => {
    saveTermCompose("/repoK", "t:1", "held for a dying shell");
    saveTermCompose("/repoK", "t:2", "another shell's text");
    disposeTermCompose("/repoK", "t:1");
    expect(loadTermCompose("/repoK", "t:1")).toBe("");
    // Sibling entries are untouched — disposal is keyed, not a flush.
    expect(loadTermCompose("/repoK", "t:2")).toBe("another shell's text");
  });

  it("disposeTermCompose mirrors the default-id normalization ('shared')", () => {
    saveTermCompose("/repoN", undefined, "no-id text");
    disposeTermCompose("/repoN", "shared");
    expect(loadTermCompose("/repoN", undefined)).toBe("");
  });

  it("disposeTermCompose is idempotent and safe on unknown keys", () => {
    expect(() => {
      disposeTermCompose("/ghost", "t:none");
      disposeTermCompose("/ghost", "t:none");
    }).not.toThrow();
  });
});

// ADJUDICATION PIN (defer D-4b-1, closed 2026-10-10 cluster D+E): the buffer
// store is IN-MEMORY ONLY — reload loses held text. This pin models a reload
// the standard way (vi.resetModules + dynamic import = a fresh module
// instance, exactly what a page reload produces) and asserts the fresh
// instance starts with an empty store. If anyone ever "fixes" reload-loss by
// persisting to storage, this pin goes red and the adjudication (PIN, don't
// persist — privacy + complexity costs the program never required; the strip
// is always visible while held, and reload-loses-held-text is honest) must be
// re-argued, not silently overridden.
describe("termCompose — in-memory-only contract (D-4b-1 adjudication: PIN, don't persist)", () => {
  it("a fresh module instance (reload model) starts with an EMPTY store", async () => {
    saveTermCompose("/reload", "shared", "held across a reload?");
    expect(loadTermCompose("/reload", "shared")).toBe("held across a reload?"); // same-session survival
    vi.resetModules();
    const fresh = await import("../../src/lib/termCompose");
    expect(fresh.loadTermCompose("/reload", "shared")).toBe(""); // reload → gone
  });
});
