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
});
