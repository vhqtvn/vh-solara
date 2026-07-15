// Unit tests for the snapshot decode pipeline (gzip+base64 application
// compression of the Stream-2 session snapshot + the GET /vh/snapshot response).
// The server (pkg/web/server.go maybeCompressSnapshot) emits, only when the
// client opted in (z=1) AND the payload exceeds the threshold:
//
//	{"encoding":"gzip64","data": base64(gzip(snapshotJSON))}
//
// These tests pin the decodeSnapshot helper contract (the same native
// DecompressionStream path the cold-load messages.batch uses), plus the
// pass-through that keeps an old server (raw JSON) working. The shared
// decodeGzip64 core is already exercised by messagesBatchDecode.test.ts; here we
// focus on the snapshot-specific envelope + the generic <T> typing path.
//
// Node 18+ (this repo targets ≥24) ships DecompressionStream + atob as globals
// (undici), so the REAL decode path runs here — no mock. The fixture is
// compressed with node:zlib gzipSync + Buffer.toString("base64"), mirroring the
// server's compress/gzip + encoding/base64 round-trip exactly.
import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { decodeSnapshot } from "../../src/sync/stream";

// encodeForTest mirrors the server's maybeCompressSnapshot compression:
// JSON.stringify → gzip → base64. Used to build a realistic fixture.
function encodeForTest(value: unknown): string {
  const inner = JSON.stringify(value);
  return Buffer.from(gzipSync(Buffer.from(inner))).toString("base64");
}

describe("decodeSnapshot (gzip+base64 snapshot payload)", () => {
  it("decodes a gzip64 envelope to the original snapshot object (server round-trip)", async () => {
    // A realistic warm-snapshot shape: structural fields + an inlined
    // transcript under messages[id]. This is exactly what the server ships
    // compressed on a warm open.
    const snap = {
      seq: 42,
      gate: { s1: { messagesLoaded: true } },
      sessions: [{ id: "s1", title: "warm", lastActivity: 100 }],
      messages: {
        s1: [
          {
            info: { id: "m1", sessionID: "s1", role: "user", time: { created: 1 } },
            parts: [{ id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "hi" }],
          },
          {
            info: { id: "m2", sessionID: "s1", role: "assistant", time: { created: 2 } },
            parts: [{ id: "p2", sessionID: "s1", messageID: "m2", type: "text", text: "yo" }],
          },
        ],
      },
    };
    const decoded = await decodeSnapshot({ encoding: "gzip64", data: encodeForTest(snap) });
    expect(decoded).toEqual(snap);
    // Spot-check the transcript survived intact (the whole point of compression
    // is to ship this verbatim, just smaller).
    expect(decoded.messages.s1).toHaveLength(2);
    expect(decoded.messages.s1[0].parts[0].text).toBe("hi");
    expect(decoded.gate.s1.messagesLoaded).toBe(true);
  });

  it("decodes a large transcript round-trip (the real-world payload shape)", async () => {
    // Mirror the live profile: ~70 messages each with several parts. The
    // compress/decode round-trip must be lossless regardless of size.
    const messages = Array.from({ length: 70 }, (_, i) => ({
      info: { id: `m${i}`, sessionID: "big", role: i % 2 ? "assistant" : "user" },
      parts: Array.from({ length: 4 }, (_, j) => ({
        id: `p${i}-${j}`,
        sessionID: "big",
        messageID: `m${i}`,
        type: "text",
        text: `chunk ${i}-${j} `.repeat(20),
      })),
    }));
    const snap = { seq: 7, gate: { big: { messagesLoaded: true } }, messages: { big: messages } };
    const decoded = await decodeSnapshot({ encoding: "gzip64", data: encodeForTest(snap) });
    expect(decoded.messages.big).toHaveLength(70);
    expect(decoded.messages.big[69].parts).toHaveLength(4);
  });

  it("passes through a raw snapshot with no encoding (old server / small snapshot under threshold)", async () => {
    // The server only compresses when z=1 AND size ≥ threshold. A cold /
    // messageless / small snapshot ships raw and must reach applySessionSnapshot
    // unchanged. Also covers an old server that never compresses. decodeSnapshot
    // returns its input verbatim in this case.
    const snap = { seq: 1, gate: { s1: { messagesLoaded: false } }, sessions: [], messages: {} };
    const decoded = await decodeSnapshot(snap as any);
    expect(decoded).toBe(snap);
  });

  it("passes through when encoding is present but data is absent (defensive)", async () => {
    // A malformed payload must not throw — fall back to the raw object.
    const decoded = await decodeSnapshot({ encoding: "gzip64" });
    expect(decoded).toEqual({ encoding: "gzip64" });
  });

  it("returns a safe empty snapshot when the decompressed payload is non-JSON (P1-WEB-043)", async () => {
    // A corrupt/garbled snapshot whose gzip64-decoded bytes are not valid JSON
    // must not throw. The helper returns {} — applySessionSnapshot treats {} as
    // a delivered-empty session (snap.messages?.[id] → undefined →
    // buildMessages([]); snap.gate?.[id] → undefined → delivered path) — so the
    // listener's apply path never sees the throw.
    const garbled = Buffer.from(gzipSync(Buffer.from("not json at all"))).toString("base64");
    const decoded = await decodeSnapshot({ encoding: "gzip64", data: garbled });
    expect(decoded).toEqual({});
  });
});
