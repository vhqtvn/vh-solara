// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";

// `hoverCapable` is a module-level const in src/tooltip.ts that evaluates
// matchMedia("(hover: hover) and (pointer: fine)") at import time. jsdom has no
// hover-capable pointer, so it resolves to false and `enter()` early-returns on
// `!hoverCapable` — the hover/focus timer paths would never arm in tests. Mock
// the tooltip module to force `hoverCapable: true` while keeping the REAL
// inspectAt/setInspectAt/placeTooltip: the inspectAt signal must be the same
// singleton the component reads (for the inspector test below).
vi.mock("../../src/tooltip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tooltip")>();
  return { ...actual, hoverCapable: true };
});

import Tooltip from "../../src/components/Tooltip";
import { setInspectAt } from "../../src/tooltip";

// jsdom does NOT populate the :hover pseudo-class from pointerover/pointermove,
// so `el.matches(":hover")` is false no matter what events we dispatch. For the
// pointer-path tests we therefore control :hover explicitly via a per-element
// `matches` spy (restored in afterEach) — that is the only jsdom gap that needs
// stubbing. The focus path is jsdom-clean: `fromFocus` bypasses :hover and
// `document.activeElement` IS tracked when we `.focus()`.
//
// HOVER_DELAY_MS is a private const (= 450) inside the component; reference the
// literal here instead of widening the module's public surface.
const HOVER_DELAY_MS = 450;

interface TipSpec {
  id: string;
  text: string;
}

// Render <Tooltip/> plus a set of tipped elements. The component listens at the
// DOCUMENT level (delegated), so the tipped elements only need to live in the
// DOM — dispatched events bubble up to the document handlers. tabIndex is
// required so `.focus()` both fires focusin AND sets document.activeElement
// (the latter is what the F5 activeElement re-check relies on).
function mountTips(specs: TipSpec[]) {
  const { container } = render(() => (
    <>
      <Tooltip />
      {specs.map((s) => (
        <div id={s.id} data-tip={s.text} tabIndex={0}>
          {s.id}
        </div>
      ))}
    </>
  ));
  const byId = (id: string) => container.querySelector(`#${id}`) as HTMLElement;
  return { container, byId };
}

const tipEl = () => document.querySelector('[role="tooltip"]') as HTMLElement | null;

describe("Tooltip", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    setInspectAt(null);
    // jsdom omits document.elementFromPoint; the inspector test defines it
    // (below). Remove it so it can't leak into another test.
    delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it("pointer: resting on a tipped element shows the bubble after the delay", () => {
    vi.useFakeTimers();
    const { byId } = mountTips([{ id: "a", text: "hello" }]);
    const a = byId("a");
    // jsdom never sets :hover — control it explicitly (see file header).
    vi.spyOn(a, "matches").mockImplementation((s: string) => s === ":hover");

    // jsdom (this version) has no PointerEvent ctor; the component's pointer
    // handlers only read e.target / e.relatedTarget (both on MouseEvent), and
    // dispatch matches by the .type string — so MouseEvent("pointerover"…)
    // reaches the "pointerover" listener correctly.
    a.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    // Not shown immediately — the delay is still pending.
    expect(tipEl()).toBeNull();

    vi.advanceTimersByTime(HOVER_DELAY_MS);
    const tip = tipEl();
    expect(tip).not.toBeNull();
    expect(tip!.textContent).toContain("hello");
  });

  it("pointer: leaving before the delay fires cancels the show", () => {
    vi.useFakeTimers();
    const { byId } = mountTips([{ id: "a", text: "hello" }]);
    const a = byId("a");

    a.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    // Pointer leaves for a non-tipped element (body) → onOut hides.
    a.dispatchEvent(
      new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
    );

    vi.advanceTimersByTime(HOVER_DELAY_MS);
    expect(tipEl()).toBeNull();
  });

  it("pointer: a stale target whose :hover is false at fire time is dropped", () => {
    vi.useFakeTimers();
    const { byId } = mountTips([{ id: "a", text: "hello" }]);
    const a = byId("a");
    // :hover is false at fire time (e.g. a pointerout was missed). The
    // defensive re-check must drop the stale target instead of showing it.
    vi.spyOn(a, "matches").mockImplementation(() => false);

    a.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    vi.advanceTimersByTime(HOVER_DELAY_MS);
    expect(tipEl()).toBeNull();
  });

  it("focus: shows after the delay even though :hover is false under keyboard focus", () => {
    vi.useFakeTimers();
    const { byId } = mountTips([{ id: "a", text: "hello" }]);
    const a = byId("a");

    // .focus() fires focusin (bubbles) and sets document.activeElement = a.
    // We deliberately never touch :hover here: the focus path bypasses it —
    // :hover is false under keyboard focus, which is exactly why a separate
    // activeElement-based re-check exists (F5).
    a.focus();

    vi.advanceTimersByTime(HOVER_DELAY_MS);
    const tip = tipEl();
    expect(tip).not.toBeNull();
    expect(tip!.textContent).toContain("hello");
  });

  it("F1 regression guard: keyboard Tab between two tipped elements swaps the tip", () => {
    // On the pre-F1-fix code (onOut did not thread fromFocus → armed with
    // fromFocus=false) the fire callback's :hover-only guard was false under
    // keyboard focus, so B's tip was suppressed. With the fix (and F5's
    // activeElement re-check), B's tip shows after the delay and A's does not.
    vi.useFakeTimers();
    const { byId } = mountTips([
      { id: "a", text: "alpha" },
      { id: "b", text: "beta" },
    ]);
    const a = byId("a");
    const b = byId("b");

    a.focus();
    vi.advanceTimersByTime(HOVER_DELAY_MS);
    expect(tipEl()?.textContent ?? "").toContain("alpha");

    // Tab to B: jsdom blurs A (focusout, relatedTarget=B) then focuses B
    // (focusin). The focusout inter-tip branch re-arms a fresh timer for B.
    b.focus();
    vi.advanceTimersByTime(HOVER_DELAY_MS);
    const tip = tipEl();
    expect(tip).not.toBeNull();
    expect(tip!.textContent).toContain("beta");
    expect(tip!.textContent).not.toContain("alpha");
  });

  it("inspector: shows the tip under its point immediately and cancels a pending hover timer", async () => {
    vi.useFakeTimers();
    const { byId } = mountTips([
      { id: "a", text: "alpha" },
      { id: "b", text: "beta" },
    ]);
    const a = byId("a");
    const b = byId("b");

    // Arm a hover timer on A (not yet fired).
    a.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    expect(tipEl()).toBeNull(); // still pending the delay

    // The inspector resolves "what's under the point" via elementFromPoint.
    // jsdom doesn't implement it, so define it here to resolve the point to B.
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => b;
    setInspectAt({ x: 10, y: 10 });
    // The inspector logic lives in a Solid createEffect; flush its reaction.
    await Promise.resolve();

    // B's tip is shown IMMEDIATELY (no delay waited) and A's pending hover
    // timer was cancelled — it does not clobber the inspector tip.
    const tip = tipEl();
    expect(tip).not.toBeNull();
    expect(tip!.textContent).toContain("beta");

    // Advancing past the delay must not fire A's now-cancelled timer.
    vi.advanceTimersByTime(HOVER_DELAY_MS);
    expect(tipEl()?.textContent ?? "").toContain("beta");

    // Dismiss the inspector → tip hides.
    setInspectAt(null);
    await Promise.resolve();
    expect(tipEl()).toBeNull();
  });
});
