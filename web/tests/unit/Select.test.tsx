// @vitest-environment jsdom
//
// Keyboard navigation for the custom Select dropdown (APG "Listbox Collapsible"
// — DOM-focus-move model, since the options are real focusable <button>s).
// Covers WCAG 2.1.1 (Keyboard) and 4.1.2 (Name, Role, Value): the component
// already exposes aria-haspopup="listbox" / aria-expanded / role="option" /
// aria-selected; these tests assert the actual keyboard behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import Select, { type SelectOption } from "../../src/components/Select";

const opts: SelectOption[] = [
  { value: "a", label: "Apple" },
  { value: "b", label: "Banana" },
  { value: "c1", label: "Cherry" },
  { value: "c2", label: "Citrus" },
];

const optsWithDisabled: SelectOption[] = [
  { value: "a", label: "Apple" },
  { value: "x", label: "Disabled", disabled: true },
  { value: "b", label: "Banana" },
];

const setup = (options = opts, value = "a") => {
  const onChange = vi.fn();
  const r = render(() => (
    <Select value={value} options={options} onChange={onChange} ariaLabel="fruit" />
  ));
  const trigger = () => r.container.querySelector(".vh-select-btn") as HTMLButtonElement;
  // .vh-select-opt nodes as they live in the DOM (including disabled ones); the
  // component's navigation filters disabled buttons in JS, so assert against the
  // raw DOM order here.
  const optionEls = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>(".vh-select-opt"));
  const isOpen = () => !!document.querySelector("[role='listbox']");
  return { onChange, trigger, optionEls, isOpen, ...r };
};

// Fire keydown on whatever currently has DOM focus (mirrors real typing).
const key = (k: string) => fireEvent.keyDown(document.activeElement as Element, { key: k });

describe("Select — keyboard navigation (WCAG 2.1.1 / APG Listbox Collapsible)", () => {
  afterEach(cleanup);

  it("ArrowDown on the closed trigger opens the popup and focuses the first option", async () => {
    const { trigger, optionEls } = setup();
    const t = trigger();
    t.focus();
    await key("ArrowDown");
    await waitFor(() => expect(document.activeElement).toBe(optionEls()[0]));
    expect(document.activeElement?.textContent).toContain("Apple");
  });

  it("Space opens the popup and focuses the first option (and does not scroll)", async () => {
    const { trigger, optionEls } = setup();
    const t = trigger();
    t.focus();
    await key(" ");
    await waitFor(() => expect(document.activeElement).toBe(optionEls()[0]));
  });

  it("ArrowUp on the closed trigger opens the popup and focuses the LAST option", async () => {
    const { trigger, optionEls } = setup();
    const t = trigger();
    t.focus();
    await key("ArrowUp");
    await waitFor(() => expect(document.activeElement).toBe(optionEls()[optionEls().length - 1]));
  });

  it("ArrowDown/ArrowUp move focus between options, wrapping at both ends", async () => {
    const { trigger, optionEls } = setup();
    trigger().focus();
    await key("ArrowDown");
    await waitFor(() => expect(document.activeElement).toBe(optionEls()[0]));

    await key("ArrowDown");
    expect(document.activeElement).toBe(optionEls()[1]); // Apple → Banana
    await key("ArrowDown");
    expect(document.activeElement).toBe(optionEls()[2]); // Banana → Cherry
    await key("ArrowDown");
    expect(document.activeElement).toBe(optionEls()[3]); // Cherry → Citrus
    await key("ArrowDown");
    expect(document.activeElement).toBe(optionEls()[0]); // wrap: Citrus → Apple
    await key("ArrowUp");
    expect(document.activeElement).toBe(optionEls()[3]); // wrap: Apple → Citrus
    await key("ArrowUp");
    expect(document.activeElement).toBe(optionEls()[2]); // Citrus → Cherry
  });

  it("Home/End jump to the first/last option", async () => {
    const { trigger, optionEls } = setup();
    trigger().focus();
    await key("ArrowDown");
    await waitFor(() => expect(document.activeElement).toBe(optionEls()[0]));

    await key("End");
    expect(document.activeElement).toBe(optionEls()[optionEls().length - 1]);
    await key("Home");
    expect(document.activeElement).toBe(optionEls()[0]);
  });

  it("Enter on a focused option fires onChange, closes the popup, and returns focus to the trigger", async () => {
    const { onChange, trigger, isOpen } = setup();
    trigger().focus();
    await key("ArrowDown");
    await waitFor(() => expect(isOpen()).toBe(true));
    await key("ArrowDown"); // Apple → Banana
    expect(document.activeElement?.textContent).toContain("Banana");

    await key("Enter");
    expect(onChange).toHaveBeenCalledWith("b");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger());
  });

  it("Escape closes the popup WITHOUT changing selection and returns focus to the trigger", async () => {
    const { onChange, trigger, isOpen } = setup();
    trigger().focus();
    await key("ArrowDown");
    await waitFor(() => expect(isOpen()).toBe(true));

    await key("Escape");
    expect(onChange).not.toHaveBeenCalled();
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger());
  });

  it("type-ahead focuses the next option whose label starts with the typed char, cycling", async () => {
    const { trigger, optionEls } = setup();
    trigger().focus();
    await key("ArrowDown");
    await waitFor(() => expect(document.activeElement).toBe(optionEls()[0])); // Apple

    await key("b");
    expect(document.activeElement).toBe(optionEls()[1]); // → Banana
    await key("c");
    expect(document.activeElement).toBe(optionEls()[2]); // Banana → Cherry
    await key("c");
    expect(document.activeElement).toBe(optionEls()[3]); // Cherry → Citrus
    await key("c");
    expect(document.activeElement).toBe(optionEls()[2]); // wrap: Citrus → Cherry
    // case-insensitive
    await key("B");
    expect(document.activeElement).toBe(optionEls()[1]); // → Banana
  });

  it("navigation skips disabled options", async () => {
    const { trigger, optionEls } = setup(optsWithDisabled, "a");
    trigger().focus();
    await key("ArrowDown");
    await waitFor(() => expect(document.activeElement).toBe(optionEls()[0])); // Apple (idx 0)

    await key("ArrowDown");
    // DOM order: Apple(0), Disabled(1), Banana(2) — disabled is skipped → Banana
    expect(document.activeElement).toBe(optionEls()[2]);
  });

  it("outside-click on the scrim closes the popup and restores focus to the trigger", async () => {
    // Mirrors the Escape handler's focus-restore contract (WCAG 2.4.3): a mouse
    // user dismissing the listbox by clicking the scrim should get focus back on
    // the trigger, just like a keyboard user pressing Escape.
    const { trigger, isOpen } = setup();
    trigger().focus();
    await key("ArrowDown");
    await waitFor(() => expect(isOpen()).toBe(true));

    const scrim = document.querySelector(".vh-select-scrim") as HTMLElement;
    expect(scrim).toBeTruthy();
    fireEvent.click(scrim);

    await waitFor(() => expect(isOpen()).toBe(false));
    expect(document.activeElement).toBe(trigger());
  });

  it("navigation stays scoped to this Select's popup when another listbox exists in the document", async () => {
    // listOptions() must query the component's own popup (popEl), not document
    // globally, so two concurrently-open Selects can't cross-navigate. We
    // simulate a second open Select by injecting a foreign [role=listbox] with
    // its own .vh-select-opt buttons. (Rendering two real open Selects isn't a
    // clean test here: both attach document keydown listeners and would fight
    // over focus independently of listOptions() scoping; this injection
    // isolates the scoping contract.)
    const { trigger } = setup(); // default opts: Apple, Banana, Cherry, Citrus
    trigger().focus();
    await key("ArrowDown");
    // This Select's own options only (exclude any foreign .vh-select-opt nodes):
    const ownOpts = () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>(".vh-select-pop .vh-select-opt"));
    await waitFor(() => expect(document.activeElement).toBe(ownOpts()[0])); // Apple

    const foreign = document.createElement("div");
    foreign.setAttribute("role", "listbox");
    foreign.innerHTML = `
      <button type="button" class="vh-select-opt">Zebra</button>
      <button type="button" class="vh-select-opt">Yak</button>`;
    document.body.appendChild(foreign);

    // Walk to the LAST own option (Citrus): Apple → Banana → Cherry → Citrus.
    await key("ArrowDown");
    expect(document.activeElement).toBe(ownOpts()[1]); // Banana
    await key("ArrowDown");
    expect(document.activeElement).toBe(ownOpts()[2]); // Cherry
    await key("ArrowDown");
    expect(document.activeElement).toBe(ownOpts()[3]); // Citrus

    // CRUX: from the last own option, ArrowDown must WRAP back to Apple (stay in
    // this popup). With the old document-global query, listOptions() would
    // instead move forward into the foreign listbox's first option (Zebra).
    await key("ArrowDown");
    expect(document.activeElement).toBe(ownOpts()[0]);
    expect(document.activeElement?.textContent).toContain("Apple");

    foreign.remove();
  });
});

// The mobile sheet branch (a centered .vh-select-overlay) is gated behind
// isMobile(), which reads matchMedia("(max-width: 640px)").matches — undefined in
// jsdom, so the branch never renders and its onClick handler (which mirrors the
// desktop scrim's focus-restore: setOpen(false); btn?.focus()) went unexercised.
// Stub matchMedia to report a mobile viewport to cover the belt-and-suspenders
// focus-restore contract on the mobile path too.
describe("Select — mobile sheet (matchMedia reports a mobile viewport)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function stubMobile() {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(max-width: 640px)",
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
  }

  it("renders the mobile overlay (not the desktop scrim) on a mobile viewport", async () => {
    stubMobile();
    const { trigger, isOpen } = setup();
    await fireEvent.click(trigger());
    await waitFor(() => expect(isOpen()).toBe(true));
    expect(document.querySelector(".vh-select-overlay")).toBeTruthy();
    expect(document.querySelector(".vh-select-scrim")).toBeNull();
  });

  it("clicking the mobile overlay closes the sheet and restores focus to the trigger", async () => {
    stubMobile();
    const { trigger, isOpen } = setup();
    trigger().focus();
    await fireEvent.click(trigger());
    await waitFor(() => expect(isOpen()).toBe(true));

    const overlay = document.querySelector(".vh-select-overlay") as HTMLElement;
    expect(overlay).toBeTruthy();
    fireEvent.click(overlay);

    await waitFor(() => expect(isOpen()).toBe(false));
    expect(document.activeElement).toBe(trigger());
  });
});

// ---- Zoom unit conversion (fixed-position style values are layout px) --------
// popStyle() computes geometry in VIEWPORT px (trigger gBCR + window.inner*),
// but the portaled popup's inline left/top|bottom/min-width/max-height are
// interpreted in the popup's own ZOOMED-LAYOUT space (CSS `zoom` on :root —
// see lib/zoom.ts). jsdom returns all-zero rects and never applies CSS zoom,
// so the trigger rect is stubbed and only the CONVERSION is under test (the
// clamp/flip math itself is unchanged and viewport-px throughout).
// Trigger rect left=400 top=500 bottom=520 width=100 on the 1024x768 jsdom
// viewport → maxH=min(340,422)=340; below=248 ≥ 220 → no flip; left=400;
// top=524. At 125%: 400/1.25=320, 524/1.25=419.2, 100/1.25=80, 340/1.25=272.
const rectOf = (o: Partial<DOMRect>) =>
  ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, ...o }) as DOMRect;
const stubTriggerRect = (trigger: HTMLElement, r: Partial<DOMRect>) =>
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return this === trigger ? rectOf(r) : rectOf();
  });
const popEl = () => document.querySelector(".vh-select-pop") as HTMLElement | null;

describe("Select — zoom conversion of the fixed popup style", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    document.documentElement.style.removeProperty("--ui-zoom");
  });

  const openWithRect = async (r: Partial<DOMRect>) => {
    const { trigger } = setup();
    stubTriggerRect(trigger(), r);
    await fireEvent.click(trigger());
    await waitFor(() => expect(popEl()).not.toBeNull());
    return popEl()!;
  };

  it("at zoom 1 the inline style equals the viewport-px geometry", async () => {
    expect([window.innerWidth, window.innerHeight]).toEqual([1024, 768]);
    document.documentElement.style.setProperty("--ui-zoom", "1");
    const pop = await openWithRect({ left: 400, top: 500, bottom: 520, right: 500, width: 100 });
    expect(parseFloat(pop.style.left)).toBeCloseTo(400);
    expect(parseFloat(pop.style.top)).toBeCloseTo(524);
    expect(parseFloat(pop.style.minWidth)).toBeCloseTo(100);
    expect(parseFloat(pop.style.maxHeight)).toBeCloseTo(340);
    expect(pop.style.bottom).toBe("");
  });

  it("at 125% the inline style is the viewport-px geometry divided by 1.25", async () => {
    document.documentElement.style.setProperty("--ui-zoom", "1.25");
    const pop = await openWithRect({ left: 400, top: 500, bottom: 520, right: 500, width: 100 });
    // Pre-fix these rendered 400/524/100/340 layout-px, so the popup visually
    // landed at 500/655 (…×1.25), offset by the zoom factor.
    expect(parseFloat(pop.style.left)).toBeCloseTo(320);
    expect(parseFloat(pop.style.top)).toBeCloseTo(419.2);
    expect(parseFloat(pop.style.minWidth)).toBeCloseTo(80);
    expect(parseFloat(pop.style.maxHeight)).toBeCloseTo(272);
  });

  it("flip-up branch converts bottom too (trigger near the viewport floor)", async () => {
    document.documentElement.style.setProperty("--ui-zoom", "1.25");
    // top=700 bottom=720 → below=48 < 220 and top>below → flip up;
    // bottom=round(768-700+4)=72 → 72/1.25=57.6; left=100 → 80.
    const pop = await openWithRect({ left: 100, top: 700, bottom: 720, right: 300, width: 200 });
    expect(pop.style.top).toBe("");
    expect(parseFloat(pop.style.bottom)).toBeCloseTo(57.6);
    expect(parseFloat(pop.style.left)).toBeCloseTo(80);
    expect(parseFloat(pop.style.minWidth)).toBeCloseTo(160);
  });
});
