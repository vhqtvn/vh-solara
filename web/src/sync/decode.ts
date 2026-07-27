// Pure async decode transforms extracted from stream.ts — the first and safest
// extraction boundary per the stream.ts invariant audit
// (.opencode/state/workstreams/refactor-maintainability/stream-invariant-audit.md §6a).
// These carry ZERO reactive state and ZERO generation tokens: pure async
// transforms, total functions (pass-through on no-envelope, `{}` / empty
// messages on malformed). Callers keep owning the gate logic (busy-gate epoch
// capture, gen-token rechecks) AROUND these calls — do NOT move gate checks
// into the decoders.
import type { MessageWindowMeta } from "../types";
import { log } from "../lib/log";

// decodeGzip64 reverses the server's gzip+base64 application compression
// (base64 → atob → Uint8Array → native DecompressionStream → UTF-8 string).
// Shared by the cold-load messages.batch decoder, the session-snapshot decoder,
// and the GET /vh/snapshot decoder so all three walk ONE decompression path.
// Returns "" when the runtime lacks DecompressionStream (an old browser) so each
// caller can fall back to whatever raw payload it has and log. No pako dep;
// relies on Chrome 80+/FF 113+/Safari 16.4+ native support (this PWA's target).
export async function decodeGzip64(data: string): Promise<string> {
  if (typeof DecompressionStream === "undefined") return "";
  // atob → binary string → Uint8Array.
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // Pipe through native gzip decompression, drain to one buffer.
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(merged);
}

// decodeMessagesBatch reverses the server's application-level compression of
// the cold-load messages.batch payload. The server emits {sessionID, encoding,
// data, window?} where data = base64( gzip( {"messages":[...]} ) ) and `window`
// (Phase 1 server-side bounded projection meta) travels SIBLING to `encoding`
// / `data` so the client can read has_older/oldest_loaded_id WITHOUT
// decompressing the messages array. sessionID stays PLAIN TEXT so the
// store/web interest filters (payloadSessionID / sendable) keep extracting it
// — replacing the whole payload with a base64 blob would silently drop the
// batch for Stream-2 (open-session) subscribers; only the heavy messages
// array is compressed. This helper returns {sessionID, messages, window?} in
// the exact shape applyMessageEvent's "messages.batch" case already consumes
// (plus the new window field), so that case is UNCHANGED in mechanism by
// compression. Exported for unit testing.
export async function decodeMessagesBatch(payload: {
  sessionID?: string;
  encoding?: string;
  data?: string;
  messages?: any[];
  window?: MessageWindowMeta;
}): Promise<{ sessionID: string; messages: any[]; window?: MessageWindowMeta }> {
  const sessionID = payload.sessionID || "";
  const window = payload.window;
  // Pass-through for a non-compressed payload (a non-conforming server, or a
  // future threshold policy that emits raw JSON below a size cutoff). Keeps the
  // helper a total function.
  if (payload.encoding !== "gzip64" || !payload.data) {
    return { sessionID, messages: payload.messages || [], window };
  }
  const text = await decodeGzip64(payload.data);
  if (!text) {
    // Older browser without DecompressionStream cannot decode. Fall back to
    // whatever inline messages arrived (likely empty) and log — the server
    // always compresses today, so this only matters for an old client.
    log.warn("sync", "DecompressionStream unavailable; messages.batch undecodable", { id: sessionID });
    return { sessionID, messages: payload.messages || [], window };
  }
  let inner: { messages?: any[] };
  try {
    inner = JSON.parse(text);
  } catch (err) {
    // Decompressed to non-JSON (corrupt/garbled batch payload). Return the same
    // safe empty envelope callers already handle for the DecompressionStream-
    // unavailable case above (empty messages array) instead of propagating the
    // throw to the listener.
    log.warn("sync", "malformed messages.batch payload (non-JSON after decompress)", {
      id: sessionID,
      err,
    });
    return { sessionID, messages: payload.messages || [], window };
  }
  return { sessionID, messages: inner.messages || [], window };
}

// decodeSnapshot reverses the server's gzip64 snapshot compression
// (pkg/web maybeCompressSnapshot) used for BOTH the Stream-2 session snapshot
// (SSE) and the GET /vh/snapshot response. Returns the decoded object.
// Pass-through when the payload carries no gzip64 envelope — covers an old
// server (never compresses) and a snapshot that fell under the server's size
// threshold (sent raw: cold/messageless partial snapshots, small trees). The
// generic <T> lets callers keep their typed Snapshot view. Exported for unit
// testing.
export async function decodeSnapshot<T = unknown>(payload: {
  encoding?: string;
  data?: string;
}): Promise<T> {
  if (payload.encoding === "gzip64" && payload.data) {
    const text = await decodeGzip64(payload.data);
    if (text) {
      try {
        return JSON.parse(text) as T;
      } catch (err) {
        // Decompressed to non-JSON (corrupt/garbled snapshot). Return a safe
        // empty snapshot ({}) — applySessionSnapshot treats {} as a delivered-
        // empty session (snap.messages?.[id] → undefined → buildMessages([]),
        // snap.gate?.[id] → undefined → delivered path) — instead of
        // propagating the throw to the listener.
        log.warn("sync", "malformed snapshot payload (non-JSON after decompress)", { err });
        return {} as T;
      }
    }
    log.warn("sync", "DecompressionStream unavailable; snapshot undecodable");
  }
  return payload as unknown as T;
}
