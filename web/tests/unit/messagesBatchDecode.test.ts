// Unit tests for the messages.batch decode pipeline (gzip+base64 application
// compression). The server (pkg/state/store.go emitMessagesBatchLocked) emits
// {sessionID, encoding:"gzip64", data: base64(gzip({"messages":[...]}))}.
// sessionID stays PLAIN so the store/web interest filters keep working — only
// the messages array is compressed. These tests pin the decode helper contract
// (atob → Uint8Array → native DecompressionStream → JSON.parse) in isolation;
// the dispatch ordering (loaded awaits the batch) is covered by the listener's
// promise-gate in stream.ts and exercised end-to-end by Playwright.
//
// Node 18+ (this repo targets ≥24) ships DecompressionStream + atob as globals
// (undici), so the REAL decode path runs here — no mock. The fixture is
// compressed with node:zlib gzipSync + Buffer.toString("base64"), mirroring the
// server's compress/gzip + encoding/base64 round-trip exactly.
import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { decodeMessagesBatch } from "../../src/sync/stream";

// encodeForTest mirrors the server's emitMessagesBatchLocked compression:
// JSON.stringify → gzip → base64. Used to build a realistic fixture.
function encodeForTest(messages: unknown): string {
  const inner = JSON.stringify({ messages });
  return Buffer.from(gzipSync(Buffer.from(inner))).toString("base64");
}

describe("decodeMessagesBatch (gzip+base64 cold-load payload)", () => {
  it("decodes a gzip64 payload to {sessionID, messages} (server round-trip)", async () => {
    const messages = [
      {
        info: { id: "m1", sessionID: "s1", role: "user", time: { created: 1 } },
        parts: [{ id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "a" }],
      },
      {
        info: { id: "m2", sessionID: "s1", role: "assistant", time: { created: 2 } },
        parts: [{ id: "p2", sessionID: "s1", messageID: "m2", type: "text", text: "b" }],
      },
    ];
    const payload = {
      sessionID: "s1",
      encoding: "gzip64",
      data: encodeForTest(messages),
    };
    const decoded = await decodeMessagesBatch(payload);
    expect(decoded.sessionID).toBe("s1");
    expect(decoded.messages).toEqual(messages);
    // Structural: two messages each carrying one part.
    expect(decoded.messages).toHaveLength(2);
    expect(decoded.messages[0].parts).toHaveLength(1);
    expect(decoded.messages[1].parts).toHaveLength(1);
  });

  it("preserves message ordering through the compress/decode round-trip", async () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({
      info: { id: `m${i}`, sessionID: "ord", role: "assistant" },
      parts: [{ id: `p${i}`, sessionID: "ord", messageID: `m${i}`, type: "text", text: `t${i}` }],
    }));
    const decoded = await decodeMessagesBatch({
      sessionID: "ord",
      encoding: "gzip64",
      data: encodeForTest(messages),
    });
    expect(decoded.messages.map((m: any) => m.info.id)).toEqual([
      "m0",
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
  });

  it("handles an empty messages array (empty cold fetch)", async () => {
    const decoded = await decodeMessagesBatch({
      sessionID: "empty",
      encoding: "gzip64",
      data: encodeForTest([]),
    });
    expect(decoded.sessionID).toBe("empty");
    expect(decoded.messages).toEqual([]);
  });

  it("passes through a non-compressed payload (encoding absent) for back-compat", async () => {
    // A future threshold policy (or a non-conforming server) might emit raw
    // JSON. The helper must be a total function and pass messages through.
    const decoded = await decodeMessagesBatch({
      sessionID: "raw",
      messages: [{ info: { id: "m1" }, parts: [] }],
    });
    expect(decoded.sessionID).toBe("raw");
    expect(decoded.messages).toEqual([{ info: { id: "m1" }, parts: [] }]);
  });

  it("returns empty messages for a gzip64 payload missing sessionID", async () => {
    // sessionID defaults to "" — does not throw.
    const decoded = await decodeMessagesBatch({
      encoding: "gzip64",
      data: encodeForTest([{ info: { id: "x" }, parts: [] }]),
    });
    expect(decoded.sessionID).toBe("");
    expect(decoded.messages).toHaveLength(1);
  });
});
