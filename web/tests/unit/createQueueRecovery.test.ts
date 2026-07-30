// @vitest-environment jsdom
//
// createQueueRecovery — the retract-to-compose (Bug 1) and mark-sent (Bug 2)
// controller, tested in isolation with fakes under createRoot. ChatView pulls
// in ~15 stateful modules, so mounting it whole for a retract test is
// impractical (mirrors the createAttachments / createComposerAutocomplete test
// precedent). The factory takes Accessor<T> inputs + explicit setters + the
// queue ops; tests pass fakes.
//
// Coverage:
//   - retract restores text + server-backed attachments, resets transient
//     composer state, and best-effort focuses+selects the textarea.
//   - occupied-composer protection: a non-empty composer (text OR attachments)
//     is NEVER silently overwritten; retraction is refused.
//   - deletion-failure aborts the restore: a 409 (non-removable dispatching),
//     a 500, and a network throw all leave the composer untouched.
//   - inline vh-attach: attachments are dropped (their held File bytes are gone
//     after enqueue → unrecoverable) with a notice; server-backed ones restore.
//   - NO enqueue / no re-dispatch happens during retract: the only queue op is
//     a single removeQueued; resolveQueued is never touched.
//   - markSent resolves an `unknown` item to terminal `sent` via the existing
//     resolve op, never enqueues/dispatches, and is a no-op for other states.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import { createQueueRecovery } from "../../src/components/chat/createQueueRecovery";
import type { QueuedMessage, RemoveQueuedResult } from "../../src/queue";
import type { Attachment } from "../../src/components/chat/createAttachments";

// A queued-message factory. attachments default to [] (backend normalizes to an
// always-present array per the settled assumptions).
function q(opts: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id: "q-1",
    order: 0,
    state: "failed",
    text: "the message",
    attachments: [],
    createdAt: 1,
    resolvedAt: 1,
    ...opts,
  };
}

interface Harness {
  recovery: ReturnType<typeof createQueueRecovery>;
  setInput: ReturnType<typeof vi.fn>;
  setAttachments: ReturnType<typeof vi.fn>;
  dismissAutocomplete: ReturnType<typeof vi.fn>;
  resetHistory: ReturnType<typeof vi.fn>;
  removeQueued: ReturnType<typeof vi.fn>;
  resolveQueued: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  setText: (v: string) => void;
  setAtts: (a: Attachment[]) => void;
  // Read accessors over the live composer state (so tests can assert the
  // TOCTOU draft was preserved, not overwritten).
  inputText: () => string;
  inputAtts: () => Attachment[];
  ta: HTMLTextAreaElement;
  taFocus: ReturnType<typeof vi.spyOn>;
  taSelect: ReturnType<typeof vi.spyOn>;
  dispose: () => void;
}

// Build a recovery controller with full control over the composer state and the
// queue ops. The composer signals are real (so the occupied-guard reads the
// live value); everything else is a spy.
function harness(opts: { initialText?: string; initialAtts?: Attachment[]; removeResult?: RemoveQueuedResult; removeMutate?: () => void } = {}): Harness {
  const removeResult: RemoveQueuedResult = opts.removeResult ?? { removed: true };
  const state = { text: opts.initialText ?? "", atts: opts.initialAtts ?? [] };
  const setInput = vi.fn((v: string) => {
    state.text = v;
  });
  const setAttachments = vi.fn((next: Attachment[]) => {
    state.atts = next;
  });
  const dismissAutocomplete = vi.fn();
  const resetHistory = vi.fn();
  const removeQueued = vi.fn(async () => {
    // Optional mid-DELETE mutation hook: simulates the operator editing the
    // composer (or adding an attachment) DURING the awaited removeQueued
    // round-trip — the TOCTOU window between the preflight occupied-guard and
    // the post-DELETE restore.
    if (opts.removeMutate) opts.removeMutate();
    return removeResult;
  });
  const resolveQueued = vi.fn(async () => {});
  const notify = vi.fn();
  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  const taFocus = vi.spyOn(ta, "focus");
  const taSelect = vi.spyOn(ta, "setSelectionRange");

  let recovery!: ReturnType<typeof createQueueRecovery>;
  const dispose = createRoot((dispose) => {
    recovery = createQueueRecovery({
      sessionId: () => "s-1",
      input: () => state.text,
      setInput,
      attachments: () => state.atts,
      setAttachments,
      dismissAutocomplete,
      resetHistory,
      textarea: () => ta,
      removeQueued,
      resolveQueued,
      notify,
    });
    return dispose;
  });

  return {
    recovery,
    setInput,
    setAttachments,
    dismissAutocomplete,
    resetHistory,
    removeQueued,
    resolveQueued,
    notify,
    setText: (v) => (state.text = v),
    setAtts: (a) => (state.atts = a),
    inputText: () => state.text,
    inputAtts: () => state.atts,
    ta,
    taFocus,
    taSelect,
    dispose,
  };
}

// Flush the queueMicrotask used by retract's best-effort focus+select.
function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("retract — restore text + server-backed attachments; reset transient state; focus", () => {
  it("deletes the item, restores the text, restores server-backed attachments, resets autocomplete+history, and focuses+selects", async () => {
    const h = harness();
    const atts = [
      { url: "file:///proj/.vh-solara/sessions/s1/a.png", filename: "a.png", mime: "image/png", path: ".vh-solara/sessions/s1/a.png" },
    ];
    await h.recovery.retract(q({ id: "q-1", state: "failed", text: "hello", attachments: atts }));
    await flushMicrotasks();

    // Single confirmed delete, then restore.
    expect(h.removeQueued).toHaveBeenCalledTimes(1);
    expect(h.removeQueued).toHaveBeenCalledWith("s-1", "q-1");
    // Text restored via setInput (ChatView's draft effect persists it).
    expect(h.setInput).toHaveBeenCalledWith("hello");
    // Server-backed attachments restored; inline vh-attach: excluded.
    expect(h.setAttachments).toHaveBeenCalledWith([
      { url: atts[0].url, filename: "a.png", mime: "image/png", path: atts[0].path },
    ]);
    // Transient composer state reset via the existing seams.
    expect(h.dismissAutocomplete).toHaveBeenCalledTimes(1);
    expect(h.resetHistory).toHaveBeenCalledTimes(1);
    // Best-effort focus + select-all of the restored text.
    expect(h.taFocus).toHaveBeenCalledTimes(1);
    expect(h.taSelect).toHaveBeenCalledWith(0, "hello".length);
    // No notice on a clean restore.
    expect(h.notify).not.toHaveBeenCalled();
    h.dispose();
  });

  it("restore with NO attachments does not call setAttachments at all", async () => {
    const h = harness();
    await h.recovery.retract(q({ state: "failed", text: "plain text", attachments: [] }));
    await flushMicrotasks();
    expect(h.setInput).toHaveBeenCalledWith("plain text");
    expect(h.setAttachments).not.toHaveBeenCalled();
    h.dispose();
  });

  it("NEVER enqueues or re-dispatches: retract touches only removeQueued (never resolveQueued)", async () => {
    const h = harness();
    await h.recovery.retract(q({ state: "failed", text: "x" }));
    await flushMicrotasks();
    expect(h.removeQueued).toHaveBeenCalledTimes(1);
    expect(h.resolveQueued).not.toHaveBeenCalled();
    h.dispose();
  });
});

describe("retract — occupied-composer protection (never silently overwrite)", () => {
  it("refuses when the composer has non-empty text: no delete, no restore, no focus", async () => {
    const h = harness({ initialText: "i am typing" });
    await h.recovery.retract(q({ state: "failed", text: "old" }));
    await flushMicrotasks();
    // Nothing touched: the operator's current draft is preserved.
    expect(h.removeQueued).not.toHaveBeenCalled();
    expect(h.setInput).not.toHaveBeenCalled();
    expect(h.setAttachments).not.toHaveBeenCalled();
    expect(h.dismissAutocomplete).not.toHaveBeenCalled();
    expect(h.resetHistory).not.toHaveBeenCalled();
    expect(h.taFocus).not.toHaveBeenCalled();
    // A clear notice tells the operator why (clearer UX than silent discard).
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][0].kind).toBe("info");
    h.dispose();
  });

  it("refuses when the composer has attachments (even with empty text)", async () => {
    const h = harness({
      initialAtts: [{ url: "file:///p/x.png", filename: "x.png", mime: "image/png" }],
    });
    await h.recovery.retract(q({ state: "failed", text: "old" }));
    await flushMicrotasks();
    expect(h.removeQueued).not.toHaveBeenCalled();
    expect(h.setInput).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it("whitespace-only text counts as empty (retraction proceeds)", async () => {
    const h = harness({ initialText: "   " });
    await h.recovery.retract(q({ state: "failed", text: "restored" }));
    await flushMicrotasks();
    expect(h.removeQueued).toHaveBeenCalledTimes(1);
    expect(h.setInput).toHaveBeenCalledWith("restored");
    h.dispose();
  });

  it("TOCTOU: an operator edit mid-DELETE aborts the restore (no overwrite; item already deleted)", async () => {
    // The preflight occupied-guard passes (composer empty), the DELETE is
    // confirmed removed, BUT during the awaited removeQueued round-trip the
    // operator typed into the composer. The post-DELETE TOCTOU re-verify MUST
    // catch this and abort the restore rather than clobber the new draft. The
    // old item is already deleted (removeQueued ran once); only the restore is
    // skipped. This is the fix for the occupied-composer TOCTOU gap.
    let mutate: () => void = () => {};
    const h = harness({
      removeMutate: () => mutate(), // fires inside the awaited removeQueued
    });
    // Wire the mid-DELETE mutation AFTER harness construction (the closure
    // reads `mutate` at retract time, which is after this assignment).
    mutate = () => h.setText("operator typed mid-flight");
    await h.recovery.retract(q({ id: "q-toctou", state: "failed", text: "old queued text" }));
    await flushMicrotasks();

    // The DELETE happened exactly once (the old item is gone — that is correct;
    // we do NOT undo a confirmed delete just because the restore was skipped).
    expect(h.removeQueued).toHaveBeenCalledTimes(1);
    expect(h.removeQueued).toHaveBeenCalledWith("s-1", "q-toctou");
    // The restore was ABORTED: no setInput, no setAttachments, no transient
    // reset, no focus — the operator's mid-flight draft is preserved intact.
    expect(h.setInput).not.toHaveBeenCalled();
    expect(h.setAttachments).not.toHaveBeenCalled();
    expect(h.dismissAutocomplete).not.toHaveBeenCalled();
    expect(h.resetHistory).not.toHaveBeenCalled();
    expect(h.taFocus).not.toHaveBeenCalled();
    // The composer still holds the operator's draft (NOT overwritten with the
    // old queued text).
    expect(h.inputText()).toBe("operator typed mid-flight");
    // A non-blocking notice explains why the restore was skipped.
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][0].kind).toBe("info");
    expect(String(h.notify.mock.calls[0][0].detail)).toMatch(/composer changed|overwriting/i);
    h.dispose();
  });

  it("TOCTOU: an attachment added mid-DELETE also aborts the restore", async () => {
    // Symmetric to the text case: an attachment added during the DELETE
    // round-trip must also abort the restore (setAttachments would otherwise
    // replace the freshly-added attachment).
    let mutate: () => void = () => {};
    const h = harness({ removeMutate: () => mutate() });
    mutate = () =>
      h.setAtts([{ url: "file:///p/new.png", filename: "new.png", mime: "image/png" }]);
    await h.recovery.retract(q({ state: "failed", text: "old", attachments: [
      { url: "file:///p/queued.png", filename: "queued.png", mime: "image/png" },
    ] }));
    await flushMicrotasks();
    expect(h.removeQueued).toHaveBeenCalledTimes(1);
    expect(h.setInput).not.toHaveBeenCalled();
    expect(h.setAttachments).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledTimes(1);
    h.dispose();
  });
});

describe("retract — deletion-failure aborts the restore (composer untouched)", () => {
  it("409 (non-removable dispatching): aborts without restoring; surfaces the non-removable reason", async () => {
    const h = harness({ removeResult: { removed: false, nonRemovable: true, reason: "409" } });
    await h.recovery.retract(q({ state: "dispatching", text: "now sending" }));
    await flushMicrotasks();
    expect(h.removeQueued).toHaveBeenCalledTimes(1);
    // Composer NEVER touched — no dangling restored draft alongside a still-
    // present (dispatching) chip.
    expect(h.setInput).not.toHaveBeenCalled();
    expect(h.setAttachments).not.toHaveBeenCalled();
    expect(h.dismissAutocomplete).not.toHaveBeenCalled();
    expect(h.taFocus).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][0].detail).toMatch(/sending/i);
    h.dispose();
  });

  it("500 (transient): aborts without restoring; reason is generic, not 'sending'", async () => {
    const h = harness({ removeResult: { removed: false, reason: "500" } });
    await h.recovery.retract(q({ state: "failed", text: "old" }));
    await flushMicrotasks();
    expect(h.setInput).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][0].detail).not.toMatch(/sending/i);
    h.dispose();
  });

  it("network error: aborts without restoring", async () => {
    const h = harness({ removeResult: { removed: false, reason: "network (reset)" } });
    await h.recovery.retract(q({ state: "failed", text: "old" }));
    await flushMicrotasks();
    expect(h.setInput).not.toHaveBeenCalled();
    expect(h.setAttachments).not.toHaveBeenCalled();
    h.dispose();
  });
});

describe("retract — inline vh-attach: attachments are unrecoverable (dropped + warned)", () => {
  it("drops inline vh-attach: chips, restores server-backed ones, and warns about the dropped inline", async () => {
    const h = harness();
    const atts = [
      { url: "file:///p/real.png", filename: "real.png", mime: "image/png", path: ".vh-solara/.../real.png" },
      { url: "vh-attach:inl3", filename: "inline.png", mime: "image/png" }, // inline — bytes gone
      { url: "vh-attach:inl4", filename: "doc.pdf", mime: "application/pdf" },
    ];
    await h.recovery.retract(q({ state: "failed", text: "t", attachments: atts }));
    await flushMicrotasks();
    // Only the server-backed attachment is restored.
    expect(h.setAttachments).toHaveBeenCalledTimes(1);
    expect(h.setAttachments.mock.calls[0][0]).toEqual([
      { url: "file:///p/real.png", filename: "real.png", mime: "image/png", path: ".vh-solara/.../real.png" },
    ]);
    // A notice warns the operator that inline attachments couldn't be recovered.
    const inlineNotice = h.notify.mock.calls.find((c) => /attachment/i.test(c[0].title));
    expect(inlineNotice).toBeTruthy();
    h.dispose();
  });

  it("only-inline attachments: restores text, restores NO attachments, warns", async () => {
    const h = harness();
    await h.recovery.retract(
      q({ state: "failed", text: "just text", attachments: [{ url: "vh-attach:inl1", filename: "x.png", mime: "image/png" }] }),
    );
    await flushMicrotasks();
    expect(h.setInput).toHaveBeenCalledWith("just text");
    expect(h.setAttachments).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(/attachment/i.test(h.notify.mock.calls[0][0].title)).toBe(true);
    h.dispose();
  });
});

describe("retract — best-effort focus/select is progressive enhancement", () => {
  it("restore succeeds even when the textarea accessor returns undefined (focus is skipped, text intact)", async () => {
    // Mobile focus-after-async-delete can be flaky / the ref may be absent. The
    // correctness bar is restoring + persisting the text; focus must not roll
    // that back.
    const state = { text: "", atts: [] as Attachment[] };
    const setInput = vi.fn((v: string) => { state.text = v; });
    let recovery!: ReturnType<typeof createQueueRecovery>;
    const dispose = createRoot((d) => {
      recovery = createQueueRecovery({
        sessionId: () => "s-1",
        input: () => state.text,
        setInput,
        attachments: () => state.atts,
        setAttachments: () => {},
        dismissAutocomplete: () => {},
        resetHistory: () => {},
        textarea: () => undefined, // no ref
        removeQueued: async () => ({ removed: true }),
        resolveQueued: async () => {},
        notify: () => {},
      });
      return d;
    });
    await recovery.retract(q({ state: "failed", text: "restored" }));
    await flushMicrotasks();
    expect(setInput).toHaveBeenCalledWith("restored"); // text restored despite no focus
    dispose();
  });
});

describe("markSent — resolve to terminal `sent` (never enqueue/dispatch)", () => {
  it("resolves an `unknown` item to `sent` via the existing resolve op", async () => {
    const h = harness();
    await h.recovery.markSent(q({ id: "q-u", state: "unknown", text: "maybe sent" }));
    expect(h.resolveQueued).toHaveBeenCalledTimes(1);
    expect(h.resolveQueued).toHaveBeenCalledWith("s-1", "q-u", "sent", expect.any(String));
    // The detail carries operator provenance.
    expect(String(h.resolveQueued.mock.calls[0][3]).toLowerCase()).toContain("operator");
    // NEVER enqueues/removes — it only records an outcome.
    expect(h.removeQueued).not.toHaveBeenCalled();
    h.dispose();
  });

  it("is a no-op for non-`unknown` states (failed/pending/dispatching/sent)", async () => {
    const h = harness();
    for (const state of ["failed", "pending", "dispatching", "sent"] as const) {
      await h.recovery.markSent(q({ state }));
    }
    expect(h.resolveQueued).not.toHaveBeenCalled();
    h.dispose();
  });
});
