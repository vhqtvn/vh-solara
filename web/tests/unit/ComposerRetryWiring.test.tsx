// @vitest-environment jsdom
//
// ComposerRetryWiring — render-level proof that the SendStatus row's Retry
// button routes through the GUARDED controller entry WITH the displayed
// record's attemptId (O2 slice 1, deferred A-F2/B-F1/C-F2/D-F2 — all four
// review seats; record-addressed since the slice-1 review A-F1). The wiring
// lives in Composer's SendStatus mount (`send={props.retrySame ?? props.send}`):
// a broken prop thread would pass EVERY controller-seam test (the semantics
// are pinned there against retrySameMessage directly) and still resurrect the
// original defects — the row's Retry silently invoking the raw composer send,
// or replaying a composer-text-matched (wrong) record. This spec mounts the
// REAL Composer + REAL SendStatus + the REAL sendActionStatus store (no
// queue/agent mocks needed: the empty stores render no queue row and the
// "Loading agents…" bar fallback) and clicks the rendered button through the
// real event model.
//
// Not asserted here ON PURPOSE: the verbatim-replay semantics — the wiring is
// payload-independent by design (retrySame receives the attemptId; the guard
// lives inside retrySameMessage and is pinned in createSendAttempts.test.ts).
// At this seam a replay assertion would only re-test the spy.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { Composer, type ComposerProps } from "../../src/components/chat/Composer";
import {
  __resetSendActionStatusForTests,
  mintSendAttempt,
  updateSendAction,
} from "../../src/lib/sendActionStatus";
import { clearQueueCache, fetchQueue, type QueuedMessage } from "../../src/queue";
import { __resetQueueDispatchModeForTests, noteQueueCustodyRefusal } from "../../src/lib/queueDispatchMode";

// Seed one retained uncertain retry-same record under the live session id —
// a row whose Retry affordance is under test. Returns the attemptId the row
// must thread.
function seedUncertainRow(text: string): string {
  const a = mintSendAttempt("s1");
  updateSendAction(a.attemptId, {
    stage: "uncertain",
    certainty: "unknown",
    recovery: "retry-same",
    detail: "enqueue timed out",
    payload: { tapText: text, text, attachments: [] },
  });
  return a.attemptId;
}

function baseProps(over: Partial<ComposerProps> = {}): ComposerProps {
  return {
    draft: () => false,
    sessionId: () => "s1",
    isChild: () => false,
    parentId: () => undefined,
    onOpenParent: () => {},
    input: () => "",
    setInput: () => {},
    focusMode: () => false,
    setFocusMode: () => {},
    working: () => false,
    sending: () => false,
    send: async () => {},
    abort: () => {},
    sendInFlight: () => false,
    readyToSend: () => true,
    curModel: () => undefined,
    curVariant: () => "",
    modelDialog: () => false,
    setModelDialog: () => {},
    // Minimal controller shims — only the members Composer's JSX reads.
    ac: {
      acItems: () => [],
      acIndex: () => 0,
      acVisible: () => false,
      setAcIndex: () => {},
      applyAc: () => {},
      onAcKeyDown: () => false,
      syncCaret: () => {},
      dismissAc: () => {},
    },
    att: {
      attachments: () => [],
      setAttachments: () => [],
      uploading: () => false,
      uploadProgress: () => null,
      presentInlineIds: () => new Set<string>(),
      removeAttachment: () => {},
      reinsertInlineChip: () => {},
      addFiles: () => {},
      flushPendingAttachments: async (_id: string) => ({ failed: [] }),
      uploadFile: async (_file: File, _id: string) => null,
      inlineFiles: new Map<string, File>(),
    },
    paste: {
      onPaste: () => {},
      pasteFromClipboard: async () => {},
      onPasteButtonDown: () => {},
      onPasteButtonUp: () => {},
      onPasteButtonClick: () => {},
      onPasteButtonBlur: () => {},
    },
    hist: { onHistoryKey: () => false, resetHistory: () => {} },
    recovery: { retract: async () => {}, markSent: async () => {} },
    refTa: () => {},
    refMirror: () => {},
    refFileInput: () => {},
    onPickFile: () => {},
    ...over,
  };
}

afterEach(() => {
  cleanup();
  __resetSendActionStatusForTests();
  // G2 wiring cells seed the real queue cache + flip the dispatch-mode state.
  clearQueueCache(["s1"]);
  __resetQueueDispatchModeForTests();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Composer → SendStatus guarded-retry wiring (row click routes retrySame(attemptId), never raw send)", () => {
  it("clicking the rendered 'Retry same message' button invokes the GUARDED entry with THAT row's attemptId — NOT the raw composer send", () => {
    const id = seedUncertainRow("wiring probe");
    const send = vi.fn(async () => {});
    const retrySame = vi.fn(async () => {});
    const r = render(() => <Composer {...baseProps({ send, retrySame })} />);

    // The uncertain row renders inside the mounted Composer with the O2
    // copy: the "Retry same message" affordance.
    const row = r.container.querySelector('.sendStatusLine[data-kind="uncertain"]');
    expect(row).toBeTruthy();
    const btn = row!.querySelector<HTMLElement>(".sendStatusBtn")!;
    expect(btn.textContent).toContain("Retry same message");

    btn.click();

    // THE WIRING CRUX: the guarded entry was invoked exactly once, WITH the
    // displayed record's attemptId (record-addressed — O2 review A-F1), and
    // the raw composer send was NOT invoked. A broken prop thread (row wired
    // to props.send, or a zero-arg call) would flip these assertions while
    // passing every controller-seam test.
    expect(retrySame).toHaveBeenCalledTimes(1);
    expect(retrySame).toHaveBeenCalledWith(id);
    expect(send).not.toHaveBeenCalled();
    r.unmount();
  });

  it("with TWO uncertain rows, clicking row A's button threads A's attemptId — the composer text cannot redirect the replay", () => {
    const idA = seedUncertainRow("alpha record");
    const idB = seedUncertainRow("beta record");
    const send = vi.fn(async () => {});
    const retrySame = vi.fn(async () => {});
    // The composer holds B's text — the OLD text-matched defect replayed B
    // from A's row. Record addressing threads whichever row was CLICKED.
    const r = render(() => <Composer {...baseProps({ send, retrySame, input: () => "beta record" })} />);

    const rows = Array.from(r.container.querySelectorAll('.sendStatusLine[data-kind="uncertain"]'));
    expect(rows).toHaveLength(2);
    // Identify row A by its payload preview ("Same message: “alpha record”")
    // and click ITS button.
    const rowA = rows.find((el) => el.textContent!.includes("alpha record"))!;
    expect(rowA).toBeTruthy();
    rowA.querySelector<HTMLElement>(".sendStatusBtn")!.click();

    expect(retrySame).toHaveBeenCalledTimes(1);
    expect(retrySame).toHaveBeenCalledWith(idA);
    expect(retrySame).not.toHaveBeenCalledWith(idB);
    expect(send).not.toHaveBeenCalled();
    r.unmount();
  });

  it("without a retrySame prop the row falls back to the raw composer send (today's minimal-harness behavior)", () => {
    const id = seedUncertainRow("wiring probe");
    const send = vi.fn(async () => {});
    const r = render(() => <Composer {...baseProps({ send })} />);
    r.container.querySelector<HTMLElement>('.sendStatusLine[data-kind="uncertain"] .sendStatusBtn')!.click();
    expect(send).toHaveBeenCalledTimes(1);
    // The fallback ignores the argument (its signature is `() => Promise<void>`)
    // — but the row still passes it; the wiring is unchanged.
    expect(send).toHaveBeenCalledWith(id);
    r.unmount();
  });
});

// Seed the REAL queue module cache with one custody-recovery-shaped unknown
// item — the exact render shape daemon stale-dispatch recovery produces
// (pkg/web/queue.go recoverStaleDispatchingLocked): terminal `unknown`, the
// retained claim-minted correlation id, and NO ambiguousDelivery marker (the
// marker lands later, at reconcile-budget terminalization). Composer's queue
// row then mounts a real QueueChip against it through the same queueFor read
// production uses.
async function seedUnknownQueueItem(text: string, opencodeMsgID = "msg_w_1"): Promise<QueuedMessage> {
  const q: QueuedMessage = {
    id: "q-w-1",
    order: 1,
    state: "unknown",
    text,
    attachments: [],
    sendConfig: { providerID: "p", modelID: "m", agent: "build" },
    opencodeMsgID,
    createdAt: 1,
    resolvedAt: 1,
    detail: "",
  };
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ items: [q] }) })));
  await fetchQueue("s1");
  vi.unstubAllGlobals();
  return q;
}

// -------------------------------------------------------------------------
// G2 custody-bypass fix (2026-10-27, annex-2 §2) — the Composer wiring-level
// render guard. In daemon-dispatch mode the generic unknown QueueChip must
// offer NO Retry affordance (the button direct-POSTs prompt_async around
// daemon custody — the server's 409 fires only AFTER a POST). The leaf guard
// lives in QueueChip (pinned there); these cells prove the suppression holds
// through the REAL Composer mount with the handler still wired, and that the
// legacy wiring (button present → routes to the wired handler) is unchanged.
// -------------------------------------------------------------------------
describe("Composer → QueueChip G2 render-guard wiring (daemon custody owns the retry affordance)", () => {
  it("custody-owned unknown chip: onRetry IS wired but the chip renders NO retry button; mark-sent/retract remain", async () => {
    await seedUnknownQueueItem("g2 wiring probe");
    noteQueueCustodyRefusal(); // projection active — a live custody owner was observed
    const retryQueuedItem = vi.fn();
    const r = render(() => (
      <Composer {...baseProps({ retryQueuedItem: (q) => retryQueuedItem(q) })} />
    ));
    const chip = r.container.querySelector('.queue-chip[data-state="unknown"]');
    expect(chip).toBeTruthy();
    // THE RENDER-GUARD CRUX: no Retry affordance on the custody-owned chip
    // even though the handler prop IS threaded (the leaf guard owns the
    // suppression; a wiring-level pass-through cannot resurrect it).
    expect(chip!.querySelector(".queue-retry")).toBeNull();
    // The sanctioned recovery affordances stay reachable through this mount.
    expect(chip!.querySelector(".queue-mark-sent")).toBeTruthy();
    expect(chip!.querySelector(".queue-retract")).toBeTruthy();
    expect(retryQueuedItem).not.toHaveBeenCalled();
    r.unmount();
  });

  it("legacy (daemon-off): the retry button renders AND routes to the wired retryQueuedItem (wiring pin, unchanged by the guard)", async () => {
    const seeded = await seedUnknownQueueItem("g2 legacy probe");
    const retryQueuedItem = vi.fn();
    const r = render(() => (
      <Composer {...baseProps({ retryQueuedItem: (q) => retryQueuedItem(q) })} />
    ));
    const btn = r.container.querySelector<HTMLElement>(
      '.queue-chip[data-state="unknown"] .queue-retry',
    )!;
    expect(btn).toBeTruthy();
    btn.click();
    expect(retryQueuedItem).toHaveBeenCalledTimes(1);
    expect(retryQueuedItem).toHaveBeenCalledWith(seeded);
    r.unmount();
  });
});
