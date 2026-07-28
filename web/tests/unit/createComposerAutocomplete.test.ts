// @vitest-environment jsdom
//
// Controller tests for web/src/components/chat/createComposerAutocomplete.ts
// (the C3 extraction from ChatView). Mirrors the queueDrain.test.ts precedent:
// the factory's deps are injected as fakes, the controller is constructed under
// a Solid `createRoot` owner (so its createEffect + onCleanup register), and the
// behavior is exercised WITHOUT a component/reactive-render harness.
//
// Each setup() registers its root dispose + textarea so afterEach tears them
// down — undisposed roots leak Solid owners across tests and corrupt the
// scheduler (effects stop re-running on signal writes).
//
// Regression guards baked in:
//   (1) stale-request guard — a slow earlier file fetch must NOT overwrite a
//       fresher candidate list after a later keystroke bumped acReq.
//   (2) keyboard precedence — onAcKeyDown returns true only for the keys it
//       owns (ArrowUp/Down/Enter/Tab/Escape) so ChatView's dispatcher falls
//       through for everything else (send / prompt-history C5).
//   (3) applyAc fires the onApplied C5 hook + splices the token + dismisses.
//   (4) draft mode suppresses /command suggestions.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createComposerAutocomplete, type ComposerAutocomplete, type ComposerAutocompleteDeps } from "../../src/components/chat/createComposerAutocomplete";
import type { AgentInfo } from "../../src/agents";

const AGENTS: AgentInfo[] = [
  { name: "build", description: "build agent" },
  { name: "review", description: "code review agent" },
  { name: "coord", description: "coordination agent" },
];

// Solid createEffect (deferred) + fetch .then chains settle on the microtask
// queue. Two microtasks + one macrotask boundary guarantees everything flushed
// (the effect's initial run, its async file-fetch merge, and any re-run).
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((r) => setTimeout(r, 0));
}

// Track every root + textarea so afterEach can tear them all down. Without
// disposal, lingering Solid owners corrupt the scheduler across tests.
const disposes: Array<() => void> = [];
const textareas: HTMLTextAreaElement[] = [];

// Simulate typing into the composer: set the input signal, mirror it onto the
// (jsdom) textarea value + caret, then sync the caret so activeToken() sees it.
async function type(ac: ComposerAutocomplete, setInput: (v: string) => void, ta: HTMLTextAreaElement, text: string) {
  setInput(text);
  ta.value = text;
  ta.selectionStart = ta.selectionEnd = text.length;
  ac.syncCaret();
  await flush();
}

function key(k: string): KeyboardEvent {
  // NOTE: the init must be { key: k }, NOT the { key } shorthand — `key` here
  // would resolve to THIS function's own name binding, not the parameter.
  // cancelable: true is required so preventDefault() actually sets defaultPrevented
  // (KeyboardEvent defaults to cancelable: false, making preventDefault a no-op).
  return new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
}

interface Setup {
  ac: ComposerAutocomplete;
  input: () => string;
  setInput: (v: string) => void;
  ta: HTMLTextAreaElement;
  applied: ReturnType<typeof vi.fn>;
  dispose: () => void;
}

function setup(o: Partial<{ draft: boolean; agents: AgentInfo[] }> = {}): Setup {
  const [input, setInput] = createSignal("");
  const [agents] = createSignal<AgentInfo[]>(o.agents ?? AGENTS);
  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  textareas.push(ta);
  const applied = vi.fn();
  const deps: ComposerAutocompleteDeps = {
    input,
    setInput,
    agents,
    textarea: () => ta,
    sessionId: () => "s1",
    draft: () => o.draft ?? false,
    onApplied: applied,
  };
  let ac!: ComposerAutocomplete;
  const dispose = createRoot((d) => {
    ac = createComposerAutocomplete(deps);
    return d;
  });
  disposes.push(dispose);
  return { ac, input, setInput, ta, applied, dispose };
}

describe("createComposerAutocomplete — visibility & filtering", () => {
  it("surfaces @mention candidates filtered by the agent name", async () => {
    const { ac, setInput, ta } = setup();
    await type(ac, setInput, ta, "@bu");
    expect(ac.acVisible()).toBe(true);
    expect(ac.acItems().map((i) => i.label)).toEqual(["@build"]);
    expect(ac.acIndex()).toBe(0);
  });

  it("lists every agent for a bare '@' and keeps selection clamped to [0,len-1]", async () => {
    const { ac, setInput, ta } = setup();
    await type(ac, setInput, ta, "@");
    expect(ac.acItems()).toHaveLength(3);
    // ArrowDown twice moves to index 2 (last); a third clamps at len-1.
    expect(ac.onAcKeyDown(key("ArrowDown"))).toBe(true);
    expect(ac.onAcKeyDown(key("ArrowDown"))).toBe(true);
    expect(ac.acIndex()).toBe(2);
    expect(ac.onAcKeyDown(key("ArrowDown"))).toBe(true); // clamp
    expect(ac.acIndex()).toBe(2);
    // ArrowUp steps back down, clamping at 0.
    expect(ac.onAcKeyDown(key("ArrowUp"))).toBe(true);
    expect(ac.onAcKeyDown(key("ArrowUp"))).toBe(true);
    expect(ac.onAcKeyDown(key("ArrowUp"))).toBe(true);
    expect(ac.onAcKeyDown(key("ArrowUp"))).toBe(true); // clamp
    expect(ac.acIndex()).toBe(0);
  });

  it("is hidden when there is no active token under the caret", async () => {
    const { ac, setInput, ta } = setup();
    await type(ac, setInput, ta, "hello world");
    expect(ac.acVisible()).toBe(false);
    expect(ac.acItems()).toEqual([]);
  });
});

describe("createComposerAutocomplete — keyboard precedence (C3 → C5 seam)", () => {
  it("owns ArrowUp/Down/Enter/Tab/Escape and prevents default when open", async () => {
    // Each key gets a FRESH populated popover: Enter/Tab call applyAc which
    // dismisses the popover (setAcItems([])), so a shared list would break the
    // next iteration. Isolating per-key also pins which key returned false.
    for (const k of ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"]) {
      const { ac, setInput, ta } = setup();
      await type(ac, setInput, ta, "@bu");
      const e = key(k);
      expect(ac.onAcKeyDown(e)).toBe(true);
      expect(e.defaultPrevented).toBe(true);
    }
  });

  it("returns false (fall through) for keys it does not own, so send/history run", async () => {
    const { ac, setInput, ta } = setup();
    await type(ac, setInput, ta, "@bu");
    // A plain character while the popup is open must fall through.
    expect(ac.onAcKeyDown(key("a"))).toBe(false);
    expect(ac.onAcKeyDown(key("Backspace"))).toBe(false);
  });

  it("returns false for every key when the popup is closed (no-op)", () => {
    const { ac } = setup();
    expect(ac.onAcKeyDown(key("ArrowDown"))).toBe(false);
    expect(ac.onAcKeyDown(key("Enter"))).toBe(false);
    expect(ac.onAcKeyDown(key("Escape"))).toBe(false);
  });

  it("Escape dismisses the popover", async () => {
    const { ac, setInput, ta } = setup();
    await type(ac, setInput, ta, "@bu");
    expect(ac.acVisible()).toBe(true);
    expect(ac.onAcKeyDown(key("Escape"))).toBe(true);
    expect(ac.acVisible()).toBe(false);
  });
});

describe("createComposerAutocomplete — applyAc (splice + C5 hook)", () => {
  it("Enter splices the selected item over the active token, dismisses, and fires onApplied", async () => {
    const { ac, setInput, ta, input, applied } = setup();
    await type(ac, setInput, ta, "@bu");
    expect(ac.onAcKeyDown(key("Enter"))).toBe(true);
    // Token range was [0,3) ("@bu"); insert "@build " replaces it.
    expect(input()).toBe("@build ");
    expect(ac.acVisible()).toBe(false);
    expect(applied).toHaveBeenCalledTimes(1);
  });

  it("applyAc(item) applies an explicit item (popover onMouseDown path)", async () => {
    const { ac, setInput, ta, input, applied } = setup();
    await type(ac, setInput, ta, "@co");
    const item = ac.acItems()[0];
    ac.applyAc(item);
    expect(input()).toBe("@coord ");
    expect(applied).toHaveBeenCalledTimes(1);
  });

  it("applyAc splices a mention that appears mid-text, preserving the tail", async () => {
    const { ac, setInput, ta, input } = setup();
    // Type the full string first so the input signal has it; caret lands at end.
    await type(ac, setInput, ta, "hi @bu there");
    // Re-position the caret to sit at index 6 (right after "@bu") and re-sync so
    // activeToken resolves the "@bu" mention (no whitespace between @ and caret).
    ta.selectionStart = ta.selectionEnd = 6;
    ac.syncCaret();
    await flush();
    expect(ac.acVisible()).toBe(true);
    ac.applyAc();
    // before="hi " (0..3), token @bu is 3..6, after=" there" (6..end).
    expect(input()).toBe("hi @build  there");
  });

  it("applyAc is a no-op (and does not fire onApplied) when there is no active token", async () => {
    const { ac, input, applied, setInput, ta } = setup();
    await type(ac, setInput, ta, "plain text");
    ac.applyAc();
    expect(input()).toBe("plain text");
    expect(applied).not.toHaveBeenCalled();
  });
});

describe("createComposerAutocomplete — draft mode suppresses /command", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [] }) as Response));
  });

  it("hides /command suggestions in draft mode even when the token is a command", async () => {
    const { ac, setInput, ta } = setup({ draft: true });
    await type(ac, setInput, ta, "/un");
    expect(ac.acVisible()).toBe(false);
    expect(ac.acItems()).toEqual([]);
  });

  it("still allows @mention suggestions in draft mode", async () => {
    const { ac, setInput, ta } = setup({ draft: true });
    await type(ac, setInput, ta, "@bu");
    expect(ac.acVisible()).toBe(true);
    expect(ac.acItems().map((i) => i.label)).toEqual(["@build"]);
  });
});

// The stale-request guard (acReq): fileSuggestions is async (a fetch). If the
// user types a second character before the first fetch resolves, the first
// (stale) result MUST NOT overwrite the fresher candidate list. Each recompute
// bumps acReq; only the most recent request's result lands in setAcItems.
describe("createComposerAutocomplete — stale-request guard (acReq)", () => {
  it("drops a stale file result that resolves after a newer keystroke", async () => {
    const releaseQueue: Array<(files: string[]) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/oc/find/file")) {
          return new Promise<Response>((res) => {
            releaseQueue.push((files: string[]) => res({ ok: true, json: async () => files } as Response));
          });
        }
        return Promise.resolve({ ok: true, json: async () => [] } as Response);
      }),
    );
    const { ac, setInput, ta } = setup();
    // "@b" matches the "build" agent (synchronous baseline) + a hanging file
    // fetch (acReq=1).
    await type(ac, setInput, ta, "@b");
    expect(ac.acItems().map((i) => i.label)).toContain("@build");
    // A second keystroke bumps acReq to 2 and switches the agent baseline to
    // "review" (its file fetch also hangs).
    await type(ac, setInput, ta, "@re");
    expect(ac.acItems().map((i) => i.label)).toContain("@review");
    // Release the FIRST (stale, for "@b") file result — it was queued before
    // the bump so the acReq guard must drop it.
    expect(releaseQueue.length).toBeGreaterThanOrEqual(1);
    releaseQueue[0](["stale.go"]);
    await flush();
    // The stale file must NOT appear, and the fresh agent baseline is intact.
    // (fileSuggestions labels a file with its raw path, NOT "@path" — the @ lives
    // only on item.insert — so the dropped label is "stale.go".)
    expect(ac.acItems().some((i) => i.label === "stale.go")).toBe(false);
    expect(ac.acItems().map((i) => i.label)).toContain("@review");
  });

  it("applies a fresh file result that is still the latest request", async () => {
    let releaseLatest: ((files: string[]) => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/oc/find/file")) {
          return new Promise<Response>((res) => {
            releaseLatest = (files: string[]) => res({ ok: true, json: async () => files } as Response);
          });
        }
        return Promise.resolve({ ok: true, json: async () => [] } as Response);
      }),
    );
    const { ac, setInput, ta } = setup();
    // "@b" matches "build" (baseline) + a hanging file fetch that is still the
    // latest request when released → its result merges in (agents + files).
    await type(ac, setInput, ta, "@b");
    expect(releaseLatest).not.toBeNull();
    releaseLatest!(["fresh.go"]);
    await flush();
    const labels = ac.acItems().map((i) => i.label);
    expect(labels).toContain("@build");
    expect(labels).toContain("fresh.go"); // file item labeled with raw path
  });
});

afterEach(() => {
  // Dispose every root created this test BEFORE unstubbing/restoring, so no
  // lingering effect observes a torn-down fetch stub.
  while (disposes.length) disposes.pop()!();
  for (const ta of textareas) ta.remove();
  textareas.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
