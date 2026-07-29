// @vitest-environment jsdom
//
// Controller tests for web/src/components/chat/createComposerPaste.ts
// (the C4 extraction from ChatView). Mirrors the createComposerAutocomplete.test
// precedent: the factory's deps are injected as fakes, the controller is
// constructed under a Solid `createRoot` owner, and the behavior is exercised
// WITHOUT a component/reactive-render harness.
//
// Regression guards baked in:
//   (1) textarea onPaste — file/image paste → harvest → addFiles + preventDefault;
//       plain-text paste falls through (no preventDefault, addFiles never called).
//   (2) paste button tap-vs-hold — classifyHold drives insert vs replace; both
//       reset the press-state closure to the downAt===0 sentinel.
//   (3) pasteFromClipboard — replace overwrites + insert splices at caret + fires
//       onTextInsert (C5 seam) + syncCaret (C3 seam); denial/empty no-op.
//   (4) onPasteButtonBlur resets a stale pointer timestamp so a later keyboard
//       activation classifies as "tap".
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createComposerPaste, type ComposerPaste, type ComposerPasteDeps } from "../../src/components/chat/createComposerPaste";
import { HOLD_THRESHOLD_MS } from "../../src/lib/copyHold";

// Solid queueMicrotask caret settle is async; flush the microtask queue.
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

// A minimal DataTransferItem/File stand-in for harvestPastedFiles (jsdom has no
// real DataTransfer). Matches lib/paste.ts FileItem = { kind, getAsFile }.
function fileItem(file: File): { kind: string; getAsFile: () => File | null } {
  return { kind: "file", getAsFile: () => file };
}

// ClipboardEvent in jsdom: clipboardData is not populated, so we build a fake
// event carrying a { files, items } stub and cast to ClipboardEvent.
function pasteEvent(opts: { files?: File[]; items?: { kind: string; getAsFile: () => File | null }[] }): ClipboardEvent {
  const cd: any = {
    files: opts.files ? opts.files.slice() : null,
    items: opts.items ? opts.items.slice() : null,
  };
  const e = { clipboardData: cd, preventDefault: vi.fn() } as unknown as ClipboardEvent;
  return e;
}

interface Setup {
  paste: ComposerPaste;
  input: () => string;
  setInput: (v: string) => void;
  ta: HTMLTextAreaElement;
  addFiles: ReturnType<typeof vi.fn>;
  syncCaret: ReturnType<typeof vi.fn>;
  onTextInsert: ReturnType<typeof vi.fn>;
  dispose: () => void;
}

function setup(): Setup {
  const [input, setInput] = createSignal("");
  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  // Mirror the signal onto the textarea value synchronously, like the real
  // component's value={input()} binding — jsdom clamps selectionStart to
  // value.length, so without this the queueMicrotask caret-set would clamp to 0
  // on an empty buffer.
  const wrappedSetInput = (v: string) => {
    setInput(v);
    ta.value = v;
  };
  const addFiles = vi.fn();
  const syncCaret = vi.fn();
  const onTextInsert = vi.fn();
  const deps: ComposerPasteDeps = {
    input,
    setInput: wrappedSetInput,
    textarea: () => ta,
    syncCaret,
    addFiles,
    onTextInsert,
  };
  let paste!: ComposerPaste;
  const dispose = createRoot((d) => {
    paste = createComposerPaste(deps);
    return d;
  });
  return { paste, input, setInput: wrappedSetInput, ta, addFiles, syncCaret, onTextInsert, dispose };
}

describe("createComposerPaste — textarea onPaste (file harvest → addFiles)", () => {
  it("harvests pasted items (items-only path) → addFiles + preventDefault", () => {
    const { paste, addFiles } = setup();
    const f1 = new File(["x"], "shot.png", { type: "image/png" });
    // Many browsers expose pasted files ONLY via .items (getAsFile), .files empty.
    const e = pasteEvent({ items: [fileItem(f1)] });
    paste.onPaste(e);
    expect((e as unknown as { preventDefault: ReturnType<typeof vi.fn> }).preventDefault).toHaveBeenCalledTimes(1);
    expect(addFiles).toHaveBeenCalledTimes(1);
    expect(addFiles).toHaveBeenCalledWith([f1]);
  });

  it("falls back to .files when items yielded nothing", () => {
    const { paste, addFiles } = setup();
    const f1 = new File(["y"], "drop.txt", { type: "text/plain" });
    const e = pasteEvent({ files: [f1] }); // items null
    paste.onPaste(e);
    expect(addFiles).toHaveBeenCalledWith([f1]);
    expect((e as unknown as { preventDefault: ReturnType<typeof vi.fn> }).preventDefault).toHaveBeenCalledTimes(1);
  });

  it("plain-text paste (no files/items) falls through: no preventDefault, no addFiles", () => {
    const { paste, addFiles } = setup();
    const e = pasteEvent({}); // both null
    paste.onPaste(e);
    expect((e as unknown as { preventDefault: ReturnType<typeof vi.fn> }).preventDefault).not.toHaveBeenCalled();
    expect(addFiles).not.toHaveBeenCalled();
  });
});

describe("createComposerPaste — paste button tap-vs-hold (classifyHold)", () => {
  afterEach(() => vi.useRealTimers());

  it("a plain tap (short elapsed) → replace-all", async () => {
    const { paste, ta } = setup();
    ta.value = "old";
    const read = vi.fn(async () => "PASTED");
    vi.stubGlobal("navigator", { clipboard: { readText: read } } as unknown as Navigator);
    paste.onPasteButtonDown();
    // No wait — a tap is an immediate click (elapsed < threshold).
    paste.onPasteButtonClick();
    await flush();
    expect(read).toHaveBeenCalled();
    expect(ta.value).toBe("PASTED"); // replace overwrote the buffer
    vi.unstubAllGlobals();
  });

  it("a hold (elapsed >= HOLD_THRESHOLD_MS) → insert-at-caret", async () => {
    const { paste, input, setInput, ta } = setup();
    setInput("hello world");
    ta.value = "hello world";
    ta.selectionStart = ta.selectionEnd = 5; // caret after "hello"
    const read = vi.fn(async () => "X");
    vi.stubGlobal("navigator", { clipboard: { readText: read } } as unknown as Navigator);
    vi.useFakeTimers();
    paste.onPasteButtonDown();
    vi.advanceTimersByTime(HOLD_THRESHOLD_MS + 10); // cross the threshold
    paste.onPasteButtonClick();
    await flush();
    expect(input()).toBe("helloX world"); // spliced at caret, tail preserved
    vi.unstubAllGlobals();
  });

  it("keyboard activation (downAt===0 sentinel) → replace (documented default)", async () => {
    const { paste, setInput, ta } = setup();
    setInput("keep");
    ta.value = "keep";
    const read = vi.fn(async () => "K");
    vi.stubGlobal("navigator", { clipboard: { readText: read } } as unknown as Navigator);
    // No onPasteButtonDown — keyboard activation leaves pasteDownAt at 0.
    paste.onPasteButtonClick();
    await flush();
    expect(read).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("onPasteButtonBlur resets a stale pointer timestamp so a later keyboard activation classifies as tap", async () => {
    const { paste, setInput, ta } = setup();
    setInput("buf");
    ta.value = "buf";
    const read = vi.fn(async () => "R");
    vi.stubGlobal("navigator", { clipboard: { readText: read } } as unknown as Navigator);
    vi.useFakeTimers();
    paste.onPasteButtonDown();
    vi.advanceTimersByTime(HOLD_THRESHOLD_MS + 50); // stale — would classify hold
    paste.onPasteButtonBlur(); // focus left → reset to sentinel
    paste.onPasteButtonClick(); // now keyboard: downAt===0 → tap → replace
    await flush();
    // replace path: read called, and the buffer was overwritten (not spliced).
    expect(read).toHaveBeenCalled();
    expect(ta.value).toBe("R");
    vi.unstubAllGlobals();
  });
});

describe("createComposerPaste — pasteFromClipboard (C3 syncCaret + C5 onTextInsert seams)", () => {
  it("replace overwrites the buffer, sets caret to end, fires onTextInsert + syncCaret", async () => {
    const { paste, input, ta, syncCaret, onTextInsert } = setup();
    vi.stubGlobal("navigator", { clipboard: { readText: async () => "abc" } } as unknown as Navigator);
    await paste.pasteFromClipboard("replace");
    await flush();
    expect(input()).toBe("abc");
    expect(ta.selectionStart).toBe(3);
    expect(ta.selectionEnd).toBe(3);
    expect(onTextInsert).toHaveBeenCalledTimes(1);
    expect(syncCaret).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("insert splices at the caret selection, preserving the tail", async () => {
    const { paste, input, setInput, ta } = setup();
    setInput("foo bar");
    ta.value = "foo bar";
    ta.selectionStart = 0;
    ta.selectionEnd = 3; // replace "foo"
    vi.stubGlobal("navigator", { clipboard: { readText: async () => "QUX" } } as unknown as Navigator);
    await paste.pasteFromClipboard("insert");
    await flush();
    expect(input()).toBe("QUX bar");
    expect(ta.selectionStart).toBe(3); // caret after the inserted text
    vi.unstubAllGlobals();
  });

  it("no-ops (focuses the field) when the clipboard read throws (denied/unsupported)", async () => {
    const { paste, input, setInput, ta, onTextInsert, syncCaret } = setup();
    setInput("keep");
    const focus = vi.spyOn(ta, "focus");
    vi.stubGlobal("navigator", { clipboard: { readText: async () => { throw new Error("denied"); } } } as unknown as Navigator);
    await paste.pasteFromClipboard("replace");
    await flush();
    expect(input()).toBe("keep"); // unchanged
    expect(onTextInsert).not.toHaveBeenCalled();
    expect(syncCaret).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("no-ops (focuses the field) when the clipboard is empty", async () => {
    const { paste, input, setInput, ta, onTextInsert } = setup();
    setInput("keep");
    const focus = vi.spyOn(ta, "focus");
    vi.stubGlobal("navigator", { clipboard: { readText: async () => "" } } as unknown as Navigator);
    await paste.pasteFromClipboard("replace");
    await flush();
    expect(input()).toBe("keep");
    expect(onTextInsert).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("onPasteButtonUp is a documented no-op (load-independent hold detection)", () => {
    const { paste } = setup();
    expect(() => paste.onPasteButtonUp()).not.toThrow();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
