// Send-path regression lock for the silent agent-flip incidents — the
// createSend SEAM counterpart of agentSilentFlip.test.ts (which locks the
// resolver). These tests drive the REAL evidence ladder end-to-end at the
// unit seam: store → resolveAgentForSession/awaitSendAgent → createSend →
// enqueue/POST body, with only the API layer mocked (same shape as
// agentSilentFlip.test.ts: /agent returns supervisor+coordination, /config
// declares default_agent "coordination" — the incident's exact posture).
//
// Acceptance windows mapped here (from the incident task contract):
//   (a) a loaded window with NO agent-stamped message + a lastAgents entry →
//       the SENT sendConfig.agent is that entry, never the config default;
//   (b) a cold session absent from lastAgents → the send WAITS and enqueues
//       only once evidence lands; on timeout → NO enqueue, an error surfaces,
//       and the composer text is preserved — the sent body never carries the
//       config default for such a session;
//   (+) dispatch-time guard for legacy queued items persisted without an
//       agent (the forbidden omit-path: opencode fills a missing `agent` with
//       its config default server-side);
//   (+) the "!" shell path gates the same way.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";

// In-memory localStorage (node env): the global default pick and the
// per-session picks map both persist through saveVersioned.
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => (k in mem ? mem[k] : null),
  setItem: (k: string, v: string) => {
    mem[k] = v;
  },
  removeItem: (k: string) => {
    delete mem[k];
  },
};

vi.mock("../../src/api", () => ({
  oc: {
    get: vi.fn((url: string) =>
      url === "/agent"
        ? Promise.resolve([{ name: "supervisor" }, { name: "coordination" }])
        : Promise.resolve({ default_agent: "coordination" }),
    ),
  },
}));

import { loadAgents, selectedAgent } from "../../src/agents";
import { awaitSendAgent, resolveAgentForSession } from "../../src/agents";
import { setState } from "../../src/sync/store";
import { createSend, type SendDependencies } from "../../src/components/chat/createSend";
import { __resetSendSingleFlightForTests } from "../../src/lib/sendSingleFlight";
import type { Attachment } from "../../src/components/chat/createAttachments";
import type { DrainOutcome } from "../../src/queueDrain";

// ---------------------------------------------------------------------------
// Harness: a createSend with every dep faked EXCEPT the agent gate, which is
// the REAL one (agents.ts), so the resolver↔send wiring is what's under test.
// ---------------------------------------------------------------------------
const notes: { kind: string; title: string; detail: string }[] = [];
// D1/D2 tests pin WHICH Attachment objects the enqueued item carries (by
// identity), so the fake enqueue records the attachments array too.
let enqueued: { id: string; text: string; sendConfig: any; attachments: Attachment[] }[] = [];
const [inputSig, setInputSig] = (() => {
  let v = "";
  return [
    () => v,
    (nv: string) => {
      v = nv;
    },
  ] as [() => string, (nv: string) => void];
})();
// Stable attachments array + setter fake: the composer-ownership contract
// compares ARRAY IDENTITY (setAttachments always produces a new array), so the
// accessor must return the SAME reference until a setter call replaces it —
// a `() => []` literal would make every identity check fail and hide the
// clear path from these tests entirely.
let atts: Attachment[] = [];
const attsSig = () => atts;
const setAttsSig = ((v: any) => {
  atts = typeof v === "function" ? v(atts) : v;
}) as <T>(v: T) => T;
let fetchCalls: { url: string; body: any }[] = [];
let fetchResponder: (() => Response | Promise<Response>) | null = null;
const realFetch = globalThis.fetch;

function makeDeps(overrides: Partial<SendDependencies> = {}): SendDependencies {
  return {
    sessionId: () => "ses_gate",
    draft: () => false,
    ensureSession: async () => "ses_gate",
    input: inputSig,
    setInput: setInputSig,
    readyToSend: () => true,
    working: () => false,
    queueMode: () => false,
    selectionFor: () => ({ providerID: "p", modelID: "m" }),
    awaitAgent: (sid: string, opts?: { signal?: AbortSignal }) => awaitSendAgent(sid, opts),
    resolveAgent: (sid: string) => resolveAgentForSession(sid),
    adoptDraftAgent: vi.fn(),
    models: () => [{ name: "m" }],
    loadModels: async () => {},
    migrateModelPick: () => {},
    curModel: () => undefined,
    enqueue: async (id: string, input: { text: string; attachments: Attachment[]; sendConfig: any }) => {
      enqueued.push({ id, text: input.text, sendConfig: input.sendConfig, attachments: input.attachments });
      return {};
    },
    isSending: () => false,
    setSending: () => {},
    userScrolledUp: () => false,
    jumpToLatest: () => {},
    pushHistory: () => {},
    resetHistory: () => {},
    pushNotification: (n: { kind: string; title: string; detail: string }) => {
      notes.push(n);
    },
    undo: () => {},
    redo: () => {},
    attachments: attsSig,
    setAttachments: setAttsSig,
    flushPendingAttachments: async () => {},
    inlineFiles: new Map(),
    uploadFile: async () => null,
    draftKey: (sid: string) => `vh.draft.${sid}`,
    ...overrides,
  };
}

function seedWindowWithoutAgentStamp(id: string, count = 2): void {
  const order = Array.from({ length: count }, (_, i) => `m${i}`);
  setState("messages", id, {
    order,
    byId: Object.fromEntries(
      order.map((mid) => [mid, { id: mid, info: { id: mid, sessionID: id, role: "user" } }]),
    ),
  });
}

async function boot(): Promise<void> {
  await loadAgents();
  expect(selectedAgent()).toBe("coordination"); // the config default, as in production
}

beforeEach(() => {
  vi.useRealTimers();
  notes.length = 0;
  enqueued = [];
  atts = [];
  fetchCalls = [];
  fetchResponder = null;
  setInputSig("");
  __resetSendSingleFlightForTests();
  setState("messages", reconcile({}));
  setState("messagesDelivered", reconcile({}));
  setState("messagesError", reconcile({}));
  setState("lastAgents", reconcile({}));
  (globalThis as any).fetch = (url: any, init?: any) => {
    fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return fetchResponder ? fetchResponder() : Promise.resolve(new Response(null, { status: 204 }));
  };
});

afterEach(() => {
  vi.useRealTimers();
  (globalThis as any).fetch = realFetch;
});

// ---------------------------------------------------------------------------
// (a) loaded window, no agent stamp, lastAgents has the entry → SENT body
// ---------------------------------------------------------------------------
describe("(a) window without agent stamps sends the lastAgents entry", () => {
  it("enqueue carries sendConfig.agent = the lastAgents entry, NOT the config default", async () => {
    await boot();
    seedWindowWithoutAgentStamp("ses_gate");
    setState("lastAgents", "ses_gate", "supervisor");

    const ctrl = createSend(makeDeps());
    setInputSig("hello there");
    await ctrl.send();

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].sendConfig.agent).toBe("supervisor");
    expect(enqueued[0].sendConfig.agent).not.toBe("coordination"); // the incident assertion
    expect(notes.filter((n) => n.kind === "error")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (b) cold session absent from lastAgents → wait, then evidence; else abort
// ---------------------------------------------------------------------------
describe("(b) cold session with no evidence", () => {
  it("send WAITS and enqueues only once evidence lands — with the landed value", async () => {
    await boot();
    const ctrl = createSend(makeDeps());
    setInputSig("waiting send");

    const p = ctrl.send();
    // Evidence lands 10ms in (a lastAgent.set stream event / snapshot patch).
    await new Promise((r) => setTimeout(r, 10));
    expect(enqueued).toHaveLength(0); // nothing sent while unresolved
    setState("lastAgents", "ses_gate", "supervisor");
    await p;

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].sendConfig.agent).toBe("supervisor");
    expect(enqueued[0].sendConfig.agent).not.toBe("coordination");
  });

  it("timeout → NO enqueue, error surfaced, composer text preserved, default never sent", async () => {
    await boot();
    vi.useFakeTimers();
    try {
      const ctrl = createSend(makeDeps());
      setInputSig("do not lose me");

      const p = ctrl.send();
      // Advance past AGENT_RESOLVE_TIMEOUT_MS (10s). Microtasks (Solid's
      // reactive effect scheduling) still flush between timer ticks.
      await vi.advanceTimersByTimeAsync(10_500);
      await p;

      expect(enqueued).toHaveLength(0); // the crux: nothing was enqueued
      expect(inputSig()).toBe("do not lose me"); // text preserved
      const errors = notes.filter((n) => n.kind === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0].title).toBe("Not sent — agent unresolved");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hydration error → same loud abort, no enqueue", async () => {
    await boot();
    const ctrl = createSend(makeDeps());
    setInputSig("still here");

    const p = ctrl.send();
    await new Promise((r) => setTimeout(r, 5));
    setState("messagesError", "ses_gate", true);
    await p;

    expect(enqueued).toHaveLength(0);
    expect(inputSig()).toBe("still here");
    expect(notes.some((n) => n.title === "Not sent — agent unresolved")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Legacy queued items persisted without an agent (the omit-path) + shell
// ---------------------------------------------------------------------------
describe("dispatch-time guard (legacy items without sendConfig.agent)", () => {
  it("resolves through the gate and the POST body carries the gated agent", async () => {
    await boot();
    seedWindowWithoutAgentStamp("ses_gate");
    setState("lastAgents", "ses_gate", "supervisor");

    const ctrl = createSend(makeDeps());
    const out: DrainOutcome = await ctrl.dispatchQueuedItem(
      "ses_gate",
      { id: "q1", text: "legacy", attachments: [], sendConfig: { providerID: "p", modelID: "m" } } as any,
      new AbortController().signal,
    );

    expect(out.state).toBe("sent");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("/prompt_async");
    expect(fetchCalls[0].body.agent).toBe("supervisor"); // gated, never omitted
    expect(fetchCalls[0].body.agent).not.toBe("coordination");
  });

  it("gate failure → NO POST, failed with a pre-POST detail (not POST-ambiguous unknown)", async () => {
    await boot();
    vi.useFakeTimers();
    try {
      const ctrl = createSend(makeDeps());

      const p = ctrl.dispatchQueuedItem(
        "ses_gate",
        { id: "q2", text: "legacy", attachments: [], sendConfig: { providerID: "p", modelID: "m" } } as any,
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(10_500);
      const out: DrainOutcome = await p;

      // Nothing was POSTed, so the item is NOT POST-ambiguous: it fails with a
      // pre-POST detail (dismissable / retract-to-compose), never the
      // "may have reached OpenCode" unknown classification.
      expect(out.state).toBe("failed");
      expect(out.detail).toContain("pre-POST");
      expect(fetchCalls).toHaveLength(0);
      expect(notes.some((n) => n.title === "Queued message not sent — agent unresolved")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("F5: the legacy gate is capped well under the drainer's 12s budget — settles failed pre-POST before drainer abort", async () => {
    await boot();
    vi.useFakeTimers();
    try {
      const ctrl = createSend(makeDeps());

      let settled: DrainOutcome | undefined;
      const p = ctrl.dispatchQueuedItem(
        "ses_gate",
        { id: "q3", text: "legacy", attachments: [], sendConfig: { providerID: "p", modelID: "m" } } as any,
        new AbortController().signal,
      ).then((o) => {
        settled = o;
        return o;
      });
      // 5.5s of fake time: the internal gate cap (5s, QUEUED_DISPATCH_GATE_TIMEOUT_MS)
      // must have fired — leaving the drainer's remaining budget as real POST
      // headroom — and classified the item failed pre-POST (nothing was sent).
      await vi.advanceTimersByTimeAsync(5_500);
      const early = settled;
      // Settle any still-pending wait INSIDE this test so it cannot leak as a
      // zombie dispatch into later tests (pre-fix the gate waits the full 10s).
      await vi.advanceTimersByTimeAsync(10_000);
      await p;

      expect(early).toBeDefined(); // capped gate settled before the drainer's 12s
      expect(early?.state).toBe("failed");
      expect(early?.detail).toContain("pre-POST");
      expect(fetchCalls).toHaveLength(0); // gate failure → never any POST
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("shell ('!') path gates the same way", () => {
  it("evidence-backed shell body carries the gated agent", async () => {
    await boot();
    setState("lastAgents", "ses_gate", "supervisor");

    const ctrl = createSend(makeDeps());
    setInputSig("!ls");
    await ctrl.send();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("/shell");
    expect(fetchCalls[0].body.agent).toBe("supervisor");
  });

  it("no evidence → shell NOT sent, text restored, error surfaced", async () => {
    await boot();
    vi.useFakeTimers();
    try {
      const ctrl = createSend(makeDeps());
      setInputSig("!rm -rf /tmp/oops");

      const p = ctrl.send();
      await vi.advanceTimersByTimeAsync(10_500);
      await p;

      expect(fetchCalls).toHaveLength(0);
      expect(inputSig()).toBe("!rm -rf /tmp/oops"); // restored after the failed shell send
      expect(notes.some((n) => n.title === "Not sent — agent unresolved")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Review findings F1/F2/F4 (composer ownership, snapshot-once, single-flight
// across the gate) — regression locks for the send() restructure.
// ---------------------------------------------------------------------------
describe("F1: composer ownership during the agent gate", () => {
  it("text typed while awaitAgent pends stays in the composer; the tap-time text enqueues", async () => {
    await boot();
    const ctrl = createSend(makeDeps());
    setInputSig("original");

    const p = ctrl.send(); // pending at tap → the gate waits
    await new Promise((r) => setTimeout(r, 10)); // inside the gate wait
    setInputSig("original + edit"); // operator edits during the wait
    setState("lastAgents", "ses_gate", "supervisor"); // evidence lands
    await p;

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].text).toBe("original"); // the OLD text was sent…
    expect(inputSig()).toBe("original + edit"); // …and the edit SURVIVED
  });
});

describe("F2: snapshot-once (display == sent)", () => {
  it("agent evidence CHANGING after tap → the sent agent is the tap-time snapshot", async () => {
    await boot();
    seedWindowWithoutAgentStamp("ses_gate");
    setState("lastAgents", "ses_gate", "supervisor"); // what the composer displays at tap

    const ctrl = createSend(makeDeps());
    setInputSig("race");
    const p = ctrl.send(); // tap
    // A later-evidence flip (stale snapshot patch / another client's
    // lastAgent.set) lands right after the tap, before the send completes.
    setState("lastAgents", "ses_gate", "coordination");
    await p;

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].sendConfig.agent).toBe("supervisor"); // the tap-time value
    expect(enqueued[0].sendConfig.agent).not.toBe("coordination");
  });

  it("pending at tap → the FIRST resolution is the sent value (not a later one)", async () => {
    await boot();
    const ctrl = createSend(makeDeps());
    setInputSig("pending tap");

    const p = ctrl.send(); // pending at tap (composer shows "Resolving agent…")
    await new Promise((r) => setTimeout(r, 10));
    setState("lastAgents", "ses_gate", "supervisor"); // FIRST valid resolution
    await new Promise((r) => setTimeout(r, 10)); // let the wait settle + display land
    setState("lastAgents", "ses_gate", "coordination"); // a LATER flip
    await p;

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].sendConfig.agent).toBe("supervisor"); // first resolution wins
  });
});

describe("F4: single-flight across the agent gate", () => {
  it("a re-tap during the agent wait is dropped — one history push, one enqueue", async () => {
    await boot();
    const pushHistory = vi.fn();
    const ctrl = createSend(makeDeps({ pushHistory }));
    setInputSig("double tap");

    const p1 = ctrl.send(); // tap
    const p2 = ctrl.send(); // re-tap while the gate wait is in flight
    await new Promise((r) => setTimeout(r, 10));
    setState("lastAgents", "ses_gate", "supervisor");
    await Promise.all([p1, p2]);

    expect(pushHistory).toHaveBeenCalledTimes(1); // no duplicate history entry
    expect(enqueued).toHaveLength(1); // no duplicate waiter→enqueue
    expect(enqueued[0].text).toBe("double tap");
  });
});

// ---------------------------------------------------------------------------
// Round-2 review findings D1–D4: attachment ownership (normal + draft-flush
// paths), shell-branch text ownership, and history writes on failure paths.
// The sendAgentGate harness mirrors the real attachments controller where the
// ownership code depends on it: attachment OBJECT identity is stable across
// upload completion for live chips, and the draft flush REPLACES pending
// (.file-carrying) chips with fresh server-backed objects (createAttachments
// flushPendingAttachments: [...prev.filter(a => !a.file), ...resolved]).
// ---------------------------------------------------------------------------
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function mkAtt(url: string, file?: unknown): Attachment {
  return {
    url, filename: url, mime: "text/plain",
    ...(file !== undefined ? { file: file as Attachment["file"] } : {}),
  } as Attachment;
}

describe("D1: attachment ownership on the normal path", () => {
  it("an attachment ADDED while awaitAgent pends is excluded from the enqueue and stays in the composer; tap-owned ones are sent and cleared", async () => {
    await boot();
    const ctrl = createSend(makeDeps());
    const A1 = mkAtt("file://tap-owned");
    const A2 = mkAtt("file://added-during-wait");
    setInputSig("with attachment");
    setAttsSig([A1]);

    const p = ctrl.send(); // pending at tap → the gate waits
    await tick();
    setAttsSig((cur: Attachment[]) => [...cur, A2]); // operator attaches during the wait
    setState("lastAgents", "ses_gate", "supervisor"); // evidence lands
    await p;

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].attachments).toHaveLength(1);
    expect(enqueued[0].attachments[0]).toBe(A1); // the tap-time set only…
    const after = attsSig();
    expect(after).toHaveLength(1); // …and the mid-wait addition SURVIVES
    expect(after[0]).toBe(A2);
    expect(inputSig()).toBe(""); // unchanged text still clears normally
  });

  it("a tap-owned attachment REMOVED during the wait is honored — not enqueued, not resurrected into the composer", async () => {
    await boot();
    const ctrl = createSend(makeDeps());
    const A1 = mkAtt("file://removed-by-user");
    const A2 = mkAtt("file://kept");
    setInputSig("removal race");
    setAttsSig([A1, A2]);

    const p = ctrl.send();
    await tick();
    setAttsSig((cur: Attachment[]) => cur.filter((x) => x !== A1)); // explicit removal during the wait
    setState("lastAgents", "ses_gate", "supervisor");
    await p;

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].attachments).toHaveLength(1);
    expect(enqueued[0].attachments[0]).toBe(A2); // A1 excluded (removed), A2 sent
    expect(attsSig()).toHaveLength(0); // A2 (sent) cleared; A1 NOT re-added
  });
});

describe("D2: attachment ownership across the draft flush", () => {
  it("a change made while flushPendingAttachments pends is not absorbed: post-await additions not sent/cleared, tap-owned still-present ones sent", async () => {
    await boot();
    setState("lastAgents", "ses_gate", "supervisor"); // agent resolved at tap
    const P1 = mkAtt("pending:1", { name: "draft.txt" } as any); // mid-upload at tap (.file set)
    const A3 = mkAtt("file://added-during-flush");
    setInputSig("draft flush race");
    setAttsSig([P1]);
    let flushResolve!: () => void;
    const ctrl = createSend(makeDeps({
      flushPendingAttachments: () => new Promise<void>((res) => { flushResolve = res; }),
    }));

    const p = ctrl.send();
    await tick(); // admission reaches the flush and pends
    // Upload completes on the SAME object (identity-stable field mutation)…
    P1.url = "file://uploaded-draft";
    // …and the operator attaches something new during the same window.
    setAttsSig((cur: Attachment[]) => [...cur, A3]);
    flushResolve();
    await p;

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].attachments).toHaveLength(1);
    expect(enqueued[0].attachments[0]).toBe(P1); // tap-owned, still present → sent
    const after = attsSig();
    expect(after).toHaveLength(1);
    expect(after[0]).toBe(A3); // the mid-flush addition was NOT absorbed
  });

  it("regression pin: the REAL flush shape (pending chip replaced by a fresh server object) still sends the tap-owned upload result", async () => {
    // createAttachments.flushPendingAttachments replaces .file-carrying chips
    // with fresh uploaded objects ([...prev.filter(a => !a.file), ...resolved]).
    // Ownership must transfer across that replacement for the tap-owned
    // pending chip, or draft attachments would silently vanish from sends.
    await boot();
    setState("lastAgents", "ses_gate", "supervisor");
    const P1 = mkAtt("pending:1", { name: "pin.txt" } as any);
    const U1 = mkAtt("file://real-upload");
    setInputSig("production flush shape");
    setAttsSig([P1]);
    const ctrl = createSend(makeDeps({
      flushPendingAttachments: async () => {
        setAttsSig((cur: Attachment[]) => [...cur.filter((a) => !a.file), U1]);
      },
    }));

    await ctrl.send();

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].attachments).toHaveLength(1);
    expect(enqueued[0].attachments[0]).toBe(U1); // the replacement is owned + sent
    expect(attsSig()).toHaveLength(0); // …and cleared with the send
  });

  it("a fresh tail LONGER than the replaced chips ([U1, A3] vs one chip) adopts NOTHING — A3 is not absorbed, nothing from the tail is sent or cleared", async () => {
    // Final-ship-review counterexample: the flush replaces ONE tap-owned
    // pending chip with a fresh U1, and a post-tap addition A3 lands after
    // the flush's own write → post-flush fresh tail [U1, A3]. The tail
    // exceeds the replaced-chip count, so it cannot be attributed to the
    // flush alone (the real flush emits at most one fresh object per removed
    // chip). Adopting the LAST object would transfer ownership to A3 — a
    // post-tap addition, the exact absorption D2 forbids — so the transfer
    // must fail closed: NO tail object is adopted, neither A3 nor U1 is
    // sent or cleared, and both remain visible in the composer.
    await boot();
    setState("lastAgents", "ses_gate", "supervisor");
    const P1 = mkAtt("pending:1", { name: "ambiguous.txt" } as any); // tap-owned pending chip (.file set)
    const U1 = mkAtt("file://flush-replacement");
    const A3 = mkAtt("file://added-during-flush");
    setInputSig("ambiguous tail");
    setAttsSig([P1]);
    const ctrl = createSend(makeDeps({
      flushPendingAttachments: async () => {
        // The real flush shape: the pending chip is replaced by a fresh object…
        setAttsSig((cur: Attachment[]) => [...cur.filter((a) => !a.file), U1]);
        // …then an operator addition lands inside the same window, AFTER the
        // flush's own write → post-flush array [U1, A3].
        setAttsSig((cur: Attachment[]) => [...cur, A3]);
      },
    }));

    await ctrl.send();

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].attachments).toHaveLength(0); // NO tail object is sent — A3 NOT absorbed (nor U1)
    const after = attsSig();
    expect(after).toHaveLength(2); // nothing cleared: both remain visible in the composer
    expect(after[0]).toBe(U1);
    expect(after[1]).toBe(A3);
  });
});

describe("D3: shell ('!') text ownership", () => {
  it("an edit made during the agent gate survives a SUCCESSFUL shell send (clear guarded); exactly one history write", async () => {
    await boot();
    const pushHistory = vi.fn();
    const ctrl = createSend(makeDeps({ pushHistory }));
    setInputSig("!ls -la");

    const p = ctrl.send(); // pending at tap → the gate waits
    await tick();
    setInputSig("!ls -la && echo edited"); // edit during the gate wait
    setState("lastAgents", "ses_gate", "supervisor");
    await p;

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("/shell");
    expect(inputSig()).toBe("!ls -la && echo edited"); // NOT erased by the clear
    expect(pushHistory).toHaveBeenCalledTimes(1); // D4: history only on success
  });

  it("an edit made during a FAILING shell request survives (restore guarded)", async () => {
    await boot();
    setState("lastAgents", "ses_gate", "supervisor"); // agent resolved at tap
    let shellRes!: (r: Response) => void;
    fetchResponder = () => new Promise<Response>((res) => { shellRes = res; });
    const ctrl = createSend(makeDeps());
    setInputSig("!deploy");

    const p = ctrl.send();
    await tick(); // clear fires (composer still holds the tap text), POST pends
    expect(inputSig()).toBe("");
    setInputSig("!deploy prod"); // NEWER edit during the shell request
    shellRes(new Response(null, { status: 500 }));
    await p;

    expect(fetchCalls).toHaveLength(1);
    expect(inputSig()).toBe("!deploy prod"); // the failure-restore did NOT overwrite it
  });
});

describe("D4: prompt history writes", () => {
  it("agent-gate timeout → ZERO history writes", async () => {
    await boot();
    vi.useFakeTimers();
    try {
      const pushHistory = vi.fn();
      const ctrl = createSend(makeDeps({ pushHistory }));
      setInputSig("no history for me");

      const p = ctrl.send();
      await vi.advanceTimersByTimeAsync(10_500);
      await p;

      expect(enqueued).toHaveLength(0);
      expect(pushHistory).not.toHaveBeenCalled();
      expect(inputSig()).toBe("no history for me");
    } finally {
      vi.useRealTimers();
    }
  });

  it("enqueue rejection → ZERO history writes, composer preserved", async () => {
    await boot();
    setState("lastAgents", "ses_gate", "supervisor");
    const pushHistory = vi.fn();
    const ctrl = createSend(makeDeps({
      pushHistory,
      enqueue: async () => { throw new Error("offline"); },
    }));
    setInputSig("queue me");

    await ctrl.send();

    expect(enqueued).toHaveLength(0);
    expect(pushHistory).not.toHaveBeenCalled();
    expect(inputSig()).toBe("queue me"); // preserved for retry
    expect(notes.some((n) => n.title === "Could not queue message")).toBe(true);
  });

  it("ordinary successful send → exactly ONE history write; an unchanged composer clears normally", async () => {
    await boot();
    setState("lastAgents", "ses_gate", "supervisor");
    const pushHistory = vi.fn();
    const ctrl = createSend(makeDeps({ pushHistory }));
    const A1 = mkAtt("file://normal");
    setInputSig("plain send");
    setAttsSig([A1]);

    await ctrl.send();

    expect(enqueued).toHaveLength(1);
    expect(pushHistory).toHaveBeenCalledTimes(1);
    expect(pushHistory).toHaveBeenCalledWith("plain send", "ses_gate");
    expect(inputSig()).toBe("");
    expect(attsSig()).toHaveLength(0);
  });
});
