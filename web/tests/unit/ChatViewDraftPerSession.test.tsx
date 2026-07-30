// @vitest-environment jsdom
//
// Regression test for the per-session draft switch clobber.
//
// SYMPTOM (operator report): switching between two root sessions, each with
// its own saved draft, did NOT restore the target session's buffer — it kept
// showing the source session's text, and the target session's persisted draft
// slot got overwritten with the source session's text.
//
// ROOT CAUSE (web/src/components/ChatView.tsx): the draft-SAVE createEffect
// depended on BOTH input() and props.sessionId:
//
//   createEffect(() => {
//     const v = input();                        // dep
//     const sid = props.sessionId || "__new__"; // dep  <- the defect
//     if (v) saveVersioned(draftKey(sid), 1, v);
//     else localStorage.removeItem(draftKey(sid));
//   });
//
// The draft-RESTORE effect (createEffect(on(() => props.sessionId, ...)))
// reloads the target session's draft into input() on a session switch. On a
// rapid sequence of session switches (A->B->A->B), Restore runs per
// transition; when Restore loads session A's draft (input="alpha") and the
// Save effect subsequently runs AFTER props.sessionId has advanced to "B"
// (but BEFORE Restore has re-run for "B"), Save writes the STALE buffer
// ("alpha") under the NEW key (draftKey("B")) — clobbering B's persisted
// draft with A's text:
//
//   observed save sequence on A->B->A->B:
//     (A,alpha) (B,beta) (A,alpha) (B,alpha)  <- last write is the clobber
//   localStorage["vh.draft.B"] ends up = "alpha" (should be "beta")
//
// (A single A->B switch does NOT clobber in jsdom because Restore, declared
// at line 1466, runs before Save at line 1502 within the same flush and
// setInput is synchronous, so Save reads the post-Restore buffer. The
// rapid multi-switch — a faithful proxy for browser timings that interleave
// Restore-across-sid-changes with Save — reproduces the clobber class
// deterministically. The fix is correct for both.)
//
// FIX: key the Save effect off input() ONLY via on(input, ...), so a bare
// props.sessionId advance never re-triggers Save with a stale buffer:
//
//   createEffect(on(input, (v) => {
//     const sid = props.sessionId || "__new__";
//     if (v) saveVersioned(draftKey(sid), 1, v);
//     else localStorage.removeItem(draftKey(sid));
//   }));
//
// The restore effect (1466-1500), draftKey, store.ts, and the storage scheme
// are correct and intentionally untouched.

// jsdom lacks window.matchMedia (read at module-load time by layout.ts via
// ChatView's transitive deps). Import the shared stub BEFORE any import that
// triggers layout.ts — see _matchMedia.ts.
import "./_matchMedia";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

// --- Mocks ------------------------------------------------------------------
// ChatView reads agents()/models() during render (the composer bar). Provide
// empty/minimal fixtures so the component mounts without the real loaders'
// network calls. We do NOT exercise send(), so sync/queue stay real (openSession
// just reserves an empty message slot — safe in jsdom).

vi.mock("../../src/agents", () => ({
  agents: () => [],
  selectedAgent: () => "",
  agentForSession: () => "",
  activeAgent: () => "",
  selectAgentForSession: vi.fn(),
  loadAgents: vi.fn(),
  setSelectedAgent: vi.fn(),
}));

vi.mock("../../src/models", () => ({
  models: () => [],
  selectionFor: () => null,
  findModel: () => undefined,
  chooseModel: vi.fn(),
  chooseVariant: vi.fn(),
  applyModel: vi.fn(),
  applyAgentModel: vi.fn(),
  migrateModelPick: vi.fn(),
  loadModels: vi.fn(),
}));

// Import ChatView AFTER the mocks are registered.
import ChatView from "../../src/components/ChatView";

// Wait long enough for at least one rAF (jsdom rAF ~16ms) + the microtask queue
// to fully drain, so each session switch's save/restore effects settle before
// the next assertion (mirrors ChatViewAutosize.test.tsx settle()).
const settle = () => new Promise<void>((r) => setTimeout(r, 100));

// versioned-envelope helper matching lib/store.saveVersioned (Envelope<T> =
// {v: number, data: T}). draftKey(sid) = "vh.draft." + sid (ChatView.tsx:65).
function seedDraft(sid: string, text: string) {
  localStorage.setItem("vh.draft." + sid, JSON.stringify({ v: 1, data: text }));
}
// Decode a persisted draft slot back to its data string, matching
// lib/store.loadVersioned's same-version fast path. Returns null if absent.
function readDraft(sid: string): string | null {
  const raw = localStorage.getItem("vh.draft." + sid);
  if (raw == null) return null;
  const parsed = JSON.parse(raw) as { v: number; data: string };
  return parsed.v === 1 ? parsed.data : null;
}

describe("composer draft — per-session switch restores the target session's buffer", () => {
  beforeEach(() => {
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "",
    })) as any;
    (globalThis as any).IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    };
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    (globalThis as any).PointerEvent = class extends MouseEvent {
      pointerId = 0;
      pointerType = "";
    };
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    (globalThis as any).fetch = undefined;
    localStorage.clear();
  });

  it("(characterization) a single A->B->A switch restores each session's draft into the buffer", async () => {
    // Documents the intended behavior on a non-rapid switch. This case does
    // not clobber even without the fix (Restore runs before Save in the same
    // flush and setInput is synchronous), but it locks the contract so a
    // future regression to the restore path is caught here too.
    seedDraft("A", "alpha");
    seedDraft("B", "beta");

    const [sid, setSid] = createSignal("A");
    const { container } = render(() => <ChatView sessionId={sid()} />);

    const ta = () => container.querySelector("textarea.composer-text") as HTMLTextAreaElement;
    expect(ta()).toBeTruthy();

    await settle();
    expect(ta().value).toBe("alpha");

    setSid("B");
    await settle();
    expect(ta().value).toBe("beta");
    expect(readDraft("B")).toBe("beta");

    setSid("A");
    await settle();
    expect(ta().value).toBe("alpha");
    expect(readDraft("A")).toBe("alpha");
  });

  it("a rapid A->B->A->B switch does NOT clobber B's persisted draft with A's text", async () => {
    // The actual regression: Save must not re-run with a stale buffer under a
    // new key when Restore and Save interleave across rapid session changes.
    // RED before the fix: Save's dependency on props.sessionId let it write
    // saveVersioned(draftKey("B"), "alpha") — the stale buffer left over from
    // Restore loading A — clobbering B's "beta".
    seedDraft("A", "alpha");
    seedDraft("B", "beta");

    const [sid, setSid] = createSignal("A");
    const { container } = render(() => <ChatView sessionId={sid()} />);

    const ta = () => container.querySelector("textarea.composer-text") as HTMLTextAreaElement;
    expect(ta()).toBeTruthy();
    await settle();
    expect(ta().value).toBe("alpha");

    // Rapid multi-switch with no settle between — mirrors the browser timings
    // that interleave Restore-across-sid-changes with Save.
    setSid("B");
    setSid("A");
    setSid("B");
    await settle();

    // After settling on B, the buffer must reflect B's draft ...
    expect(ta().value).toBe("beta");
    // ... and B's persisted slot must NOT have been clobbered to A's text.
    // This is the deterministic red signal for the clobber.
    expect(readDraft("B")).toBe("beta");
    // A's slot must also be intact.
    expect(readDraft("A")).toBe("alpha");
  });
});
