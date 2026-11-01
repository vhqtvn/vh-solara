// @vitest-environment jsdom
//
// streamEpochParam.test.ts — F1 epoch handshake (P2 follow-up), client side.
// Both stream openers (tree-transport.ts connect() for Stream 1,
// session-stream.ts openSessionES for Stream 2) must append
// `&epoch=<encodeURIComponent(declared)>` to the /vh/stream URL IFF the
// client can name its store lifetime: state.epoch (set only by an applied
// snapshot, cleared on project switch) or — round 2/3, before any snapshot
// of this page life — the PERSISTED previous lifetime (readBootEpoch in
// ./bootEpoch.ts; a returning boot's first URL then carries the handshake,
// covering the persisted state.cursor and remembered session cursors).
// Omitted only when BOTH are unknown (first-ever visit, pre-snapshot):
// that path is fresh anyway, and omission keeps old-server behavior
// byte-identical. The readBootEpoch fallback's lifecycle (persistence
// writes, reconstruction, adoption) is covered by
// epochHandshakeLifecycle.test.ts.
//
// Seam: MockEventSource captures the constructed URL (same lane-5 mechanism
// as partAppendStreaming.test.ts's part_delta=1 negotiation tests).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

class MockEventSource {
  static CLOSED = CLOSED;
  static OPEN = OPEN;
  static CONNECTING = CONNECTING;

  url: string;
  readyState = CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Array<(e: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    const arr = this.listeners.get(type);
    if (arr) arr.push(fn);
    else this.listeners.set(type, [fn]);
  }
  close(): void {
    this.readyState = CLOSED;
  }
  fire(type: string, data: unknown, lastEventId = ""): void {
    const ev = new MessageEvent(type, { data: typeof data === "string" ? data : JSON.stringify(data) });
    Object.defineProperty(ev, "lastEventId", { value: lastEventId });
    const arr = this.listeners.get(type);
    if (arr) for (const fn of arr) fn(ev);
  }
}

let instances: MockEventSource[] = [];
// Stream 1 (tree): sessions= EMPTY in the URL. Stream 2 (session): sessions=<id>.
const treeES = (): MockEventSource =>
  instances.find((e) => e.readyState !== CLOSED && e.url.includes("sessions=&")) as MockEventSource;
const sessionES = (): MockEventSource =>
  instances.find((e) => e.readyState !== CLOSED && /sessions=[^&]/.test(e.url)) as MockEventSource;

let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");
let stream: typeof import("../../src/sync/stream") = null as unknown as typeof import("../../src/sync/stream");

async function setupFresh(): Promise<void> {
  vi.resetModules();
  instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
  window.localStorage.clear();
  store = await import("../../src/sync/store");
  stream = await import("../../src/sync/stream");
  store.setProjectDirRaw("/test");
}

beforeEach(async () => {
  await setupFresh();
});

afterEach(() => {
  stream?.closeSessionStream();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

describe("epoch handshake — tree stream (Stream 1) URL construction", () => {
  it("appends &epoch=<epoch> when the epoch is known (coexists with cursor)", () => {
    store.setState("epoch", "ep-known-1");
    store.setState("cursor", 42);
    stream.connect();
    const es = treeES();
    expect(es).toBeTruthy();
    expect(es.url).toContain("&epoch=ep-known-1");
    // The handshake coexists with the resume cursor and capability params.
    expect(es.url).toContain("cursor=42&");
    expect(es.url).toContain("tree=2");
    expect(es.url).toContain("z=1");
  });

  it("OMITS the epoch param when unknown (first-ever connect / pre-snapshot)", () => {
    expect(store.state.epoch).toBe("");
    stream.connect();
    const es = treeES();
    expect(es).toBeTruthy();
    expect(es.url).not.toContain("epoch=");
  });

  it("encodes hostile epoch values (encodeURIComponent)", () => {
    store.setState("epoch", "e/1&x=y z");
    stream.connect();
    const es = treeES();
    expect(es.url).toContain(`&epoch=${encodeURIComponent("e/1&x=y z")}`);
    // The encoded value must not inject additional query params.
    expect(es.url).not.toContain("x=y");
  });
});

describe("epoch handshake — session stream (Stream 2) URL construction", () => {
  it("appends &epoch=<epoch> when the epoch is known", () => {
    store.setState("epoch", "ep-known-2");
    stream.openSessionStream("s1");
    const es = sessionES();
    expect(es).toBeTruthy();
    expect(es.url).toContain("&epoch=ep-known-2");
    expect(es.url).toContain("sessions=s1");
    expect(es.url).toContain("z=1");
  });

  it("OMITS the epoch param when unknown", () => {
    expect(store.state.epoch).toBe("");
    stream.openSessionStream("s1");
    const es = sessionES();
    expect(es).toBeTruthy();
    expect(es.url).not.toContain("epoch=");
  });
});
