// @vitest-environment jsdom
// Unit coverage for the shared `modal` directive's focus policy
// (lib/a11y.ts → attachModal → focusFirst). Drives attachModal directly rather
// than going through Solid so we can pin matchMedia + offsetParent.
//
// jsdom caveats this works around:
//  - jsdom does NOT implement window.matchMedia (focusFirst reads it to detect
//    coarse pointers). We stub it per-test to flip coarse/fine.
//  - jsdom always returns null for HTMLElement.offsetParent, and focusables()
//    uses offsetParent !== null to drop hidden elements. We mark the elements
//    we care about as visible via stubVisible().
//  - focusFirst is scheduled with queueMicrotask; we flush with await of a
//    resolved promise before asserting document.activeElement.
import { describe, expect, it } from "vitest";
import { attachModal } from "../../src/lib/a11y";

// Make jsdom treat the given elements as laid-out (focusables() keeps them).
function stubVisible(...els: HTMLElement[]) {
  for (const el of els) {
    Object.defineProperty(el, "offsetParent", {
      configurable: true,
      value: document.body,
    });
  }
}

// matchMedia stub: when `coarse` is true, only the `(pointer: coarse)` query
// matches; everything else reports false (so any future query stays benign).
function setCoarse(coarse: boolean) {
  const w = globalThis as unknown as { matchMedia?: unknown };
  w.matchMedia = (query: string) => ({
    matches: coarse && query === "(pointer: coarse)",
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

// focusFirst is queued on a microtask; a single awaited tick flushes it.
const flush = () => Promise.resolve();

function detachAfter(detach: () => void) {
  // Remove the keydown listener + decrement modalCount so tests stay isolated.
  detach();
}

describe("attachModal — focusFirst coarse-pointer policy", () => {
  it("coarse pointer: skips a leading text input, focuses the next focusable (button)", async () => {
    setCoarse(true);
    const root = document.createElement("div");
    const input = document.createElement("input");
    input.type = "text";
    const btn = document.createElement("button");
    btn.textContent = "close";
    root.append(input, btn);
    document.body.append(root);
    stubVisible(input, btn);

    const detach = attachModal(root);
    await flush();
    expect(document.activeElement).toBe(btn);
    detachAfter(detach);
  });

  it("coarse pointer: a bare <input> (no type attr) is treated as a keyboard-popper and skipped", async () => {
    setCoarse(true);
    const root = document.createElement("div");
    const input = document.createElement("input"); // no type → defaults to text
    const btn = document.createElement("button");
    root.append(input, btn);
    document.body.append(root);
    stubVisible(input, btn);

    const detach = attachModal(root);
    await flush();
    expect(document.activeElement).toBe(btn);
    detachAfter(detach);
  });

  it("coarse pointer: falls back to the container when only a keyboard-popper is focusable", async () => {
    setCoarse(true);
    const root = document.createElement("div");
    const input = document.createElement("input");
    input.type = "search";
    root.append(input);
    document.body.append(root);
    stubVisible(input);

    const detach = attachModal(root);
    await flush();
    // No non-keyboard candidate → container focused and made focusable.
    expect(document.activeElement).toBe(root);
    expect(root.tabIndex).toBe(-1);
    detachAfter(detach);
  });

  it("coarse pointer: data-autofocus-keyboard opts back in to focusing the keyboard-popper", async () => {
    setCoarse(true);
    const root = document.createElement("div");
    root.setAttribute("data-autofocus-keyboard", "");
    const input = document.createElement("input");
    input.type = "text";
    const btn = document.createElement("button");
    root.append(input, btn);
    document.body.append(root);
    stubVisible(input, btn);

    const detach = attachModal(root);
    await flush();
    expect(document.activeElement).toBe(input);
    detachAfter(detach);
  });

  it("fine pointer: focuses the first focusable (the input) regardless of type — no desktop regression", async () => {
    setCoarse(false);
    const root = document.createElement("div");
    const input = document.createElement("input");
    input.type = "text";
    const btn = document.createElement("button");
    root.append(input, btn);
    document.body.append(root);
    stubVisible(input, btn);

    const detach = attachModal(root);
    await flush();
    expect(document.activeElement).toBe(input);
    detachAfter(detach);
  });

  it("coarse pointer: non-keyboard types (select/button) remain valid auto-focus targets", async () => {
    setCoarse(true);
    const root = document.createElement("div");
    const select = document.createElement("select");
    root.append(select);
    document.body.append(root);
    stubVisible(select);

    const detach = attachModal(root);
    await flush();
    expect(document.activeElement).toBe(select);
    detachAfter(detach);
  });

  it("coarse pointer: a <textarea> is skipped (it also pops the soft keyboard)", async () => {
    setCoarse(true);
    const root = document.createElement("div");
    const ta = document.createElement("textarea");
    const btn = document.createElement("button");
    root.append(ta, btn);
    document.body.append(root);
    stubVisible(ta, btn);

    const detach = attachModal(root);
    await flush();
    expect(document.activeElement).toBe(btn);
    detachAfter(detach);
  });
});
