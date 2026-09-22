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
      uploading: () => false,
      uploadProgress: () => null,
      presentInlineIds: () => new Set<string>(),
      removeAttachment: () => {},
      reinsertInlineChip: () => {},
      addFiles: () => {},
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
  vi.clearAllMocks();
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
    const btn = row!.querySelector(".sendStatusBtn")!;
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
    rowA.querySelector(".sendStatusBtn")!.click();

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
    r.container.querySelector('.sendStatusLine[data-kind="uncertain"] .sendStatusBtn')!.click();
    expect(send).toHaveBeenCalledTimes(1);
    // The fallback ignores the argument (its signature is `() => Promise<void>`)
    // — but the row still passes it; the wiring is unchanged.
    expect(send).toHaveBeenCalledWith(id);
    r.unmount();
  });
});
