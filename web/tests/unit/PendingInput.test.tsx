// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";

// PendingInput holds no markdown/sync deps — it is a pure composition shell.
// We test the interaction-scoped follow hold aggregation: pointer, focus,
// child-to-child focus transitions, and the onHoldChange callback.

import { type JSX } from "solid-js";
import PendingInput, {
  usePendingInputHold,
  type PendingInputHoldReport,
} from "../../src/components/PendingInput";

// jsdom does not ship IntersectionObserver or PointerEvent. PendingInput binds
// an IO on mount (root = scrollRoot); the stub makes observe()/disconnect()
// no-ops. The jump-pill visibility path is not under test here (it needs real
// IO entries). PointerEvent stub extends MouseEvent (pointer events inherit
// mouse event fields) so the delegated onPointerEnter/onPointerLeave handlers
// fire when we dispatch pointerenter/pointerleave.
class IOStub {
  cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
class PointerEventStub extends MouseEvent {
  pointerId: number;
  pointerType: string;
  constructor(type: string, init: any = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.pointerType = init.pointerType ?? "";
  }
}
beforeEach(() => {
  (globalThis as any).IntersectionObserver = IOStub;
  (globalThis as any).PointerEvent = PointerEventStub;
  (window as any).PointerEvent = PointerEventStub;
});
afterEach(() => {
  delete (globalThis as any).IntersectionObserver;
  delete (globalThis as any).PointerEvent;
  delete (window as any).PointerEvent;
});

// Capture the hold report from context via a child component (SolidJS has no
// Context.Consumer render-prop — use useContext). The component body runs once
// at mount, so this grabs the stable report object once.
function HoldCapture(props: {
  onReport: (r: PendingInputHoldReport | undefined) => void;
  children: JSX.Element;
}) {
  props.onReport(usePendingInputHold());
  return props.children as unknown as JSX.Element;
}

// Minimal scrollRoot / pillMount stand-ins (PendingInput only needs them to
// exist for the IntersectionObserver binding; the observer is a no-op in
// jsdom since it never fires synthetic entries here).
function makeRoots() {
  const scrollRoot = document.createElement("div");
  const pillMount = document.createElement("div");
  document.body.appendChild(scrollRoot);
  document.body.appendChild(pillMount);
  return { scrollRoot, pillMount };
}

// A card-like child with two focusable controls so we can test child-to-child
// focus transitions (the hold must survive moving focus between siblings).
function CardStub() {
  return (
    <div class="card-stub">
      <button type="button" class="ctrl-a">
        A
      </button>
      <button type="button" class="ctrl-b">
        B
      </button>
    </div>
  );
}

describe("PendingInput — interaction-scoped follow hold aggregation", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("onHoldChange fires false on mount, then true on pointerenter, false on pointerleave", () => {
    const { scrollRoot, pillMount } = makeRoots();
    const onHoldChange = vi.fn();
    const { container } = render(() => (
      <PendingInput
        scrollRoot={() => scrollRoot}
        pillMount={() => pillMount}
        pillLabel={() => "Permission requested"}
        onJump={() => {}}
        onHoldChange={onHoldChange}
      >
        <CardStub />
      </PendingInput>
    ));
    // Initial mount: held is false.
    expect(onHoldChange).toHaveBeenLastCalledWith(false);

    const wrapper = container.querySelector(".pending-input") as HTMLElement;
    // pointerenter → held true.
    wrapper.dispatchEvent(new PointerEvent("pointerenter"));
    expect(onHoldChange).toHaveBeenLastCalledWith(true);
    // pointerleave → held false.
    wrapper.dispatchEvent(new PointerEvent("pointerleave"));
    expect(onHoldChange).toHaveBeenLastCalledWith(false);
  });

  it("focusin sets held true", () => {
    const { scrollRoot, pillMount } = makeRoots();
    const onHoldChange = vi.fn();
    const { container } = render(() => (
      <PendingInput
        scrollRoot={() => scrollRoot}
        pillMount={() => pillMount}
        pillLabel={() => "Answer needed"}
        onJump={() => {}}
        onHoldChange={onHoldChange}
      >
        <CardStub />
      </PendingInput>
    ));
    const a = container.querySelector(".ctrl-a") as HTMLButtonElement;
    a.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(onHoldChange).toHaveBeenLastCalledWith(true);
  });

  it("focusout moving to a sibling child keeps held true (no transient release)", () => {
    const { scrollRoot, pillMount } = makeRoots();
    const onHoldChange = vi.fn();
    const { container } = render(() => (
      <PendingInput
        scrollRoot={() => scrollRoot}
        pillMount={() => pillMount}
        pillLabel={() => "Answer needed"}
        onJump={() => {}}
        onHoldChange={onHoldChange}
      >
        <CardStub />
      </PendingInput>
    ));
    const wrapper = container.querySelector(".pending-input") as HTMLElement;
    const a = container.querySelector(".ctrl-a") as HTMLButtonElement;
    const b = container.querySelector(".ctrl-b") as HTMLButtonElement;

    // Focus A → held true.
    a.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(onHoldChange).toHaveBeenLastCalledWith(true);

    // Focus moves A → B (both inside the wrapper). focusout fires on A with
    // relatedTarget = B (inside hostRef) → held must stay true.
    a.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: b }),
    );
    expect(onHoldChange).toHaveBeenLastCalledWith(true);
    expect(wrapper).toBeTruthy();
  });

  it("focusout to outside the wrapper releases held", () => {
    const { scrollRoot, pillMount } = makeRoots();
    const onHoldChange = vi.fn();
    const { container } = render(() => (
      <PendingInput
        scrollRoot={() => scrollRoot}
        pillMount={() => pillMount}
        pillLabel={() => "Answer needed"}
        onJump={() => {}}
        onHoldChange={onHoldChange}
      >
        <CardStub />
      </PendingInput>
    ));
    const a = container.querySelector(".ctrl-a") as HTMLButtonElement;
    const outside = document.createElement("button");
    document.body.appendChild(outside);

    a.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(onHoldChange).toHaveBeenLastCalledWith(true);

    // Focus moves to an element OUTSIDE the wrapper → held false.
    a.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }),
    );
    expect(onHoldChange).toHaveBeenLastCalledWith(false);
  });

  it("popup-open reported via context keeps held true even when focus leaves the wrapper", () => {
    // Models the portaled-popup focus transfer: focusout fires with
    // relatedTarget=null (portal is outside the DOM subtree), which would
    // release a focus-only hold. But the child card reports popupOpen=true
    // via the context, so held stays true.
    const { scrollRoot, pillMount } = makeRoots();
    const onHoldChange = vi.fn();
    let report: PendingInputHoldReport | undefined;
    const { container } = render(() => (
      <PendingInput
        scrollRoot={() => scrollRoot}
        pillMount={() => pillMount}
        pillLabel={() => "Answer needed"}
        onJump={() => {}}
        onHoldChange={onHoldChange}
      >
        <HoldCapture onReport={(r) => (report = r)}>
          <CardStub />
        </HoldCapture>
      </PendingInput>
    ));
    expect(report).toBeTruthy();

    // Focus enters the card.
    const a = container.querySelector(".ctrl-a") as HTMLButtonElement;
    a.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(onHoldChange).toHaveBeenLastCalledWith(true);

    // Popup opens (child reports it via context).
    report!.setPopupOpen(true);
    expect(onHoldChange).toHaveBeenLastCalledWith(true);

    // Focus leaves to the portaled popup (relatedTarget=null).
    a.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    // held STAYS true because popupOpen is active.
    expect(onHoldChange).toHaveBeenLastCalledWith(true);

    // Popup closes → now the only hold reason is gone → held false.
    report!.setPopupOpen(false);
    expect(onHoldChange).toHaveBeenLastCalledWith(false);
  });

  it("pinned-reveal reported via context keeps held true independently of pointer/focus", () => {
    // Models the touch eye-toggle pin: the hold stays active while the pinned
    // reveal is open, even with no pointer/focus.
    const { scrollRoot, pillMount } = makeRoots();
    const onHoldChange = vi.fn();
    let report: PendingInputHoldReport | undefined;
    render(() => (
      <PendingInput
        scrollRoot={() => scrollRoot}
        pillMount={() => pillMount}
        pillLabel={() => "Answer needed"}
        onJump={() => {}}
        onHoldChange={onHoldChange}
      >
        <HoldCapture onReport={(r) => (report = r)}>
          <CardStub />
        </HoldCapture>
      </PendingInput>
    ));
    expect(report).toBeTruthy();

    onHoldChange.mockClear();
    report!.setPinnedReveal(true);
    expect(onHoldChange).toHaveBeenLastCalledWith(true);

    report!.setPinnedReveal(false);
    expect(onHoldChange).toHaveBeenLastCalledWith(false);
  });

  it("releases hold (emits false) on unmount while held (commit-review tier1_b/F1)", () => {
    // Regression: the reporting createEffect is disposed on unmount WITHOUT
    // re-running, so without an explicit onCleanup(false) the receiver's
    // holdActive would stick true forever and silently break live tail-follow.
    // Models: hover/focus/pin blocker → answer the permission → card unmounts.
    const { scrollRoot, pillMount } = makeRoots();
    const onHoldChange = vi.fn();
    let report: PendingInputHoldReport | undefined;
    const { container } = render(() => (
      <PendingInput
        scrollRoot={() => scrollRoot}
        pillMount={() => pillMount}
        pillLabel={() => "Permission requested"}
        onJump={() => {}}
        onHoldChange={onHoldChange}
      >
        <HoldCapture onReport={(r) => (report = r)}>
          <CardStub />
        </HoldCapture>
      </PendingInput>
    ));
    // Drive the hold true via pinned-reveal (survives unmount with no DOM
    // event to release it first — the worst case for the stuck-hold bug).
    expect(report).toBeTruthy();
    onHoldChange.mockClear();
    report!.setPinnedReveal(true);
    expect(onHoldChange).toHaveBeenLastCalledWith(true);

    // Unmount the card while held (the blocker was answered). cleanup() tears
    // down the SolidJS owner, running all onCleanup handlers including the
    // new onCleanup(false) that releases the hold.
    cleanup();
    // The receiver MUST observe false after disposal — this is the exact
    // assertion that failed before the onCleanup(false) fix.
    expect(onHoldChange).toHaveBeenLastCalledWith(false);
    // Sanity: the wrapper is gone from the DOM.
    expect(container.querySelector(".pending-input")).toBeNull();
  });
});
