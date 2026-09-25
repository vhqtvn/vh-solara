// @vitest-environment jsdom
//
// RED SIGNAL for the operator-reported bug: "after creating a new session the
// chat viewport doesn't render at all — all empty. Switching to another
// session and back makes it render. Was intermittent at first, now seems to
// always happen."
//
// Full-path reproduction (no setState shortcuts): the exact production mount
// tree from App.tsx (non-keyed <Show when={selectedId()}> with the draft
// fallback), the REAL sync wiring from startSync()
//   createRoot(() => createEffect(on(selectedId, (id) =>
//     openSessionStream(id ?? ""), { defer: true })))
// the REAL createSession() (POST /oc/session via mocked global fetch → real
// setSelectedId + openSession), and a MockEventSource standing in for the
// Stream-2 /vh/stream EventSource whose first snapshot carries the session
// record (snap.sessions), the gate, and the (empty) message list — exactly
// what applySessionSnapshot consumes.
//
// The tests encode the delivery-ordering matrix the earlier
// intermittency suggests (SSE snapshot vs the POST-return/mount ordering ×
// warm/cold gate × whether the completion signal follows), so a race
// reproduces deterministically in at least one cell:
//   A. snapshot fired as a microtask at EventSource construction (tightest
//      faithful post-flush ordering), gate.messagesLoaded=true
//   B. snapshot fired AFTER mount (25ms delay), gate.messagesLoaded=true
//   C. snapshot at construction, gate.messagesLoaded=false + a later
//      messages.loaded frame (the cold-hydration two-frame shape)
//   D. snapshot after mount, gate.messagesLoaded=false + later messages.loaded
//   E/E2. THE WEDGE (the reported symptom): gate.messagesLoaded=false and the
//      messages.loaded completion signal NEVER arrives on the open connection,
//      while the turn's live message events DO stream — the reveal gate must
//      open from the first live message, not hide the transcript behind
//      "Loading conversation…" until a manual session switch.
//
// PASS CONDITION (the user-visible outcome): the live session's chat viewport
// REVEALS — .chat-content mounts with the `ready` class (revealed()), the
// composer is present — and a streamed user message (message.upsert +
// part.upsert on Stream 2) actually renders in the transcript.

// jsdom lacks window.matchMedia (read at module-load time by layout.ts via
// code/frame.ts via ChatView's transitive deps). Import the shared stub
// BEFORE any import that triggers layout.ts — see _matchMedia.ts.
import "./_matchMedia";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { fireEvent } from "@testing-library/dom";
import { Show, createEffect, createRoot, on } from "solid-js";

// --- Mocks (module surfaces), same shapes as ChatViewDraftSend.test.tsx ------

const { enqueueMock } = vi.hoisted(() => ({
  enqueueMock: vi.fn(async () => "fake-item-id"),
}));

vi.mock("../../src/agents", () => ({
  agents: () => [{ name: "build", description: "build agent", mode: "primary" }],
  selectedAgent: () => "build",
  agentForSession: () => "build",
  awaitSendAgent: async () => ({ ok: true, agent: "build" }),
  resolveAgentForSession: () => ({ state: "agent", agent: "build" }),
  adoptDraftAgent: vi.fn(),
  selectAgentForSession: vi.fn(),
  loadAgents: vi.fn(),
  setSelectedAgent: vi.fn(),
}));

vi.mock("../../src/models", () => ({
  models: () => [{
    providerID: "test",
    modelID: "m1",
    provider: "Test",
    name: "M1",
    label: "Test / M1",
    variants: [],
  }],
  selectionFor: () => null,
  findModel: () => undefined,
  chooseVariant: vi.fn(),
  chooseModel: vi.fn(),
  applyModel: vi.fn(),
  loadModels: vi.fn(),
  // createSend's admission path calls deps.migrateModelPick (models.ts) when a
  // draft materializes into a live id — without this export the real createSend
  // throws AFTER the flip and logs unhandled rejections.
  migrateModelPick: vi.fn(),
}));

// queue: real module, only enqueue overridden so sendText's durable-custody
// step resolves without a network round-trip (fetchQueue's mocked {} means the
// drainer never sees an item — the streamed reply is fired manually below).
vi.mock("../../src/queue", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, enqueue: enqueueMock };
});

// sync: fully REAL — the real createSession (POST /oc/session through the
// mocked global fetch below), real setSelectedId/openSession/store. No override.

// --- MockEventSource (Stream 2) ----------------------------------------------
//
// Fires the first session snapshot per the test's ordering policy:
//   "at-open"  — queued as a MICROTASK inside the constructor (lands after the
//                synchronous selection flush — selectedId → follower opens ES →
//                Show swap → live ChatView mount — but before any timer; the
//                tightest FAITHFUL delivery ordering. Real EventSources always
//                deliver async; firing synchronously inside the constructor is
//                dropped by session-stream's register-after-construct order.)
//   "delayed"  — 25ms after construction (lands after mount + effects)
// gateLoaded=true snapshots mark delivered immediately (warm); gateLoaded=false
// snapshots keep delivered=false until a messages.loaded frame fires (cold,
// two-frame hydration) — scheduled 25ms after the snapshot when
// loadedFollowup="later". loadedFollowup="never" models THE WEDGE: the server
// never delivers the completion signal on this connection while the turn's
// live message events DO flow (the operator's stuck-behind-"Loading
// conversation…" shape; only a manual session switch re-snapshots warm).
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
    const m = /sessions=([^&]+)/.exec(url);
    if (!m) return; // tree stream — not modeled here
    const sid = decodeURIComponent(m[1]);
    const snap = {
      seq: 1,
      gate: { [sid]: { messagesLoaded: policy.gateLoaded } },
      messages: { [sid]: [] },
      // The Stream-2 snapshot hydrates the session STRUCT record
      // (applySessionSnapshot reads snap.sessions) — the tree-SSE record's
      // stand-in for the race matrix.
      sessions: [{ id: sid, title: "New chat" }],
    };
    const deliver = () => {
      this.fire("snapshot", snap, "1.0");
      if (!policy.gateLoaded && policy.loadedFollowup === "later") {
        setTimeout(() => this.fire("messages.loaded", { sessionID: sid }, "2.0"), 25);
      }
    };
    if (policy.snapshot === "at-open") queueMicrotask(deliver);
    else setTimeout(deliver, 25);
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
    const ev = new MessageEvent(type, {
      data: typeof data === "string" ? data : JSON.stringify(data),
    });
    Object.defineProperty(ev, "lastEventId", { value: lastEventId });
    const arr = this.listeners.get(type);
    if (arr) for (const fn of arr) fn(ev);
  }
}

let instances: MockEventSource[] = [];
const policy: {
  snapshot: "at-open" | "delayed";
  gateLoaded: boolean;
  loadedFollowup: "later" | "never";
} = {
  snapshot: "at-open",
  gateLoaded: true,
  loadedFollowup: "later",
};
const NEW_ID = "ses_new_live_1";

// --- Imports AFTER mocks ------------------------------------------------------

import ChatView from "../../src/components/ChatView";
import { openSessionStream, closeSessionStream } from "../../src/sync/session-stream";
import {
  selectedId,
  draft,
  setState,
  setProjectDirRaw,
  setSelectedIdRaw,
  setDraft,
} from "../../src/sync/store";
import { newSession as realNewSession } from "../../src/sync/actions";

// The production Stream-2 follower wiring from startSync() (sync.ts:63-65),
// created OUTSIDE the rendered tree exactly as at app boot.
let disposeFollower: (() => void) | undefined;

beforeEach(() => {
  instances = [];
  policy.snapshot = "at-open";
  policy.gateLoaded = true;
  policy.loadedFollowup = "later";
  (globalThis as unknown as { EventSource?: unknown }).EventSource = MockEventSource;
  // fetch router: POST /oc/session → { id: NEW_ID } (the real createSession
  // path); everything else (ack, queue, models) → generic ok {}. The
  // create-certainty capability probe answers 404 (route-unsupported ⇒ the
  // client's LEGACY lane), keeping this suite faithfully on the /oc/session
  // create it exercises.
  (globalThis as any).fetch = vi.fn(async (url: any, init?: any) => {
    if (String(url).includes("/vh/session/create")) {
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    }
    if (String(url).endsWith("/oc/session") && init?.method === "POST") {
      return { ok: true, status: 200, json: async () => ({ id: NEW_ID }), text: async () => "" };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  }) as any;
  (globalThis as any).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
  (globalThis as any).PointerEvent = class extends MouseEvent {
    pointerId = 0;
    pointerType = "";
  };
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  localStorage.clear();
  // Fresh per-test selection state (module-singleton store).
  setSelectedIdRaw(null);
  setDraft(false);
  setProjectDirRaw("/test");
  disposeFollower = createRoot((dispose) => {
    createEffect(on(selectedId, (id) => openSessionStream(id ?? ""), { defer: true }));
    return dispose;
  });
});

afterEach(() => {
  disposeFollower?.();
  disposeFollower = undefined;
  closeSessionStream();
  cleanup();
  setSelectedIdRaw(null);
  setDraft(false);
  setState("messages", NEW_ID, undefined as any);
  setState("messagesDelivered", NEW_ID, undefined as any);
  setState("messagesError", NEW_ID, undefined as any);
  setState("refreshing", NEW_ID, undefined as any);
  enqueueMock.mockClear();
  localStorage.clear();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
  (globalThis as any).fetch = undefined;
});

// The App.tsx mount shape for the chat view (App.tsx:417-425): the NON-KEYED
// <Show when={selectedId()}> with the draft fallback branch.
const MountTree = () => (
  <Show
    when={selectedId()}
    fallback={
      <Show when={draft()} fallback={<div data-test="empty-state" />}>
        <ChatView sessionId="" draft />
      </Show>
    }
  >
    <ChatView sessionId={selectedId()!} />
  </Show>
);

// Drive the full reported repro: New session → type → Send (real createSession
// through mocked POST /oc/session) → assert the LIVE viewport reveals and
// renders message content.
//
// streamWhileCold (cell E): fire the turn's live message events IMMEDIATELY
// after the selection flips — while the gate is still cold and (per policy)
// no messages.loaded will EVER arrive on this connection — then assert the
// viewport reveals WITH the content. This is the exact operator symptom
// shape: live content flowing for a session whose completion signal was
// never delivered.
async function driveNewSessionSend(
  container: HTMLElement,
  opts: { streamWhileCold?: boolean } = {},
): Promise<void> {
  // 1. Enter draft mode (the "New session" button action).
  realNewSession();
  expect(selectedId()).toBeNull();
  await waitFor(() => {
    expect(container.querySelector(".chat-hero")).toBeTruthy();
  });

  // 2. Type the first message into the draft composer.
  const textarea = container.querySelector("textarea.composer-text") as HTMLTextAreaElement;
  expect(textarea).toBeTruthy();
  fireEvent.input(textarea, { target: { value: "hello new session" } });

  // 3. Send (button enabled once readyToSend — agents + models mocked loaded).
  const sendBtn = container.querySelector('button[aria-label="Send"]') as HTMLButtonElement;
  expect(sendBtn).toBeTruthy();
  await waitFor(() => expect(sendBtn.disabled).toBe(false));
  fireEvent.click(sendBtn);

  // The real createSession must have run (POST /oc/session mocked above) and
  // flipped the selection to the new live id.
  await waitFor(() => expect(selectedId()).toBe(NEW_ID));

  if (opts.streamWhileCold) {
    // The turn's events arrive on the still-cold connection (no completion
    // signal under loadedFollowup="never").
    const es0 = instances.find((e) => e.url.includes(NEW_ID) && e.readyState !== CLOSED);
    expect(es0).toBeTruthy();
    es0!.fire("message.upsert", { sessionID: NEW_ID, id: "u1", role: "user", time: { created: 1000 } }, "3.0");
    es0!.fire("part.upsert", { id: "p1", sessionID: NEW_ID, messageID: "u1", type: "text", text: "hello new session" }, "3.1");
  }

  // 4. THE RED ASSERTION (user-visible outcome): the live session's chat
  //    viewport must REVEAL — .chat-content present WITH the ready class.
  //    Before the fix this times out: the viewport stays blank until a manual
  //    session switch (the reported symptom).
  await waitFor(
    () => {
      const content = container.querySelector(".chat-content");
      expect(content).toBeTruthy();
      expect(content!.className).toMatch(/\bready\b/);
    },
    { timeout: 3000 },
  );

  // 5. The composer must be live (not stuck on the draft hero).
  await waitFor(() => {
    expect(container.querySelector(".chat-hero")).toBeFalsy();
    expect(container.querySelector("textarea.composer-text")).toBeTruthy();
  });

  // 6. Streamed content renders: fire the dispatched user message back on the
  //    session stream (message row + text part) and assert the transcript
  //    actually shows it.
  if (!opts.streamWhileCold) {
    const es = instances.find((e) => e.url.includes(NEW_ID) && e.readyState !== CLOSED);
    expect(es).toBeTruthy();
    es!.fire("message.upsert", { sessionID: NEW_ID, id: "u1", role: "user", time: { created: 1000 } }, "3.0");
    es!.fire("part.upsert", { id: "p1", sessionID: NEW_ID, messageID: "u1", type: "text", text: "hello new session" }, "3.1");
  }
  await waitFor(() => {
    expect(container.textContent).toContain("hello new session");
  });
}

describe("ChatView new-session blank viewport — draft→live reveal (full path)", () => {
  it("A: reveals when the snapshot+session record land BEFORE the live view mounts (warm gate)", async () => {
    policy.snapshot = "at-open";
    policy.gateLoaded = true;
    const { container } = render(() => <MountTree />);
    await driveNewSessionSend(container);
  });

  it("B: reveals when the snapshot+session record land AFTER the live view mounts (warm gate)", async () => {
    policy.snapshot = "delayed";
    policy.gateLoaded = true;
    const { container } = render(() => <MountTree />);
    await driveNewSessionSend(container);
  });

  it("C: reveals when the cold gate (messagesLoaded=false) is followed by messages.loaded (snapshot before mount)", async () => {
    policy.snapshot = "at-open";
    policy.gateLoaded = false;
    const { container } = render(() => <MountTree />);
    await driveNewSessionSend(container);
  });

  it("D: reveals when the cold gate is followed by messages.loaded after mount", async () => {
    policy.snapshot = "delayed";
    policy.gateLoaded = false;
    const { container } = render(() => <MountTree />);
    await driveNewSessionSend(container);
  });

  // E — THE WEDGE (the operator's symptom, encoded): the snapshot's gate says
  // cold, the completion signal (messages.loaded) is NEVER delivered on this
  // connection, and the turn's live events stream into a transcript the reveal
  // gate keeps hidden. The watchdog cannot heal it (pings flow; the live
  // events ARE content), so only a manual session switch (fresh warm
  // snapshot) recovers — "switching to another session and back makes it
  // render". The first live message for a session the client has only ever
  // seen empty must itself open the reveal.
  it("E: reveals from the first live message when the cold gate's completion signal never arrives", async () => {
    policy.snapshot = "at-open";
    policy.gateLoaded = false;
    policy.loadedFollowup = "never";
    const { container } = render(() => <MountTree />);
    await driveNewSessionSend(container, { streamWhileCold: true });
  });

  it("E2: same wedge, delayed snapshot (cold gate never completes)", async () => {
    policy.snapshot = "delayed";
    policy.gateLoaded = false;
    policy.loadedFollowup = "never";
    const { container } = render(() => <MountTree />);
    await driveNewSessionSend(container, { streamWhileCold: true });
  });
});
