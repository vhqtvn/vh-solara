// @vitest-environment jsdom
//
// S1b: the embedded terminal-dock DEFAULT presentation (web/src/ui.ts).
// When the SPA runs inside the host shell's iframe (isEmbedded()), the FIRST
// open of the terminal dock in a session presents overlay-full (.full) so
// opening a terminal never permanently consumes pane vertical space;
// standalone keeps the bottom-dock default. An explicit setTermFull (the
// Dock/Full-screen toggle, or a back-dismissal) records the session's choice,
// which then wins over the default.
//
// termFull/termOpen are module-level signals, so each case re-imports ui.ts
// fresh (vi.resetModules + dynamic import) with the desired window.parentage
// installed first — the same fake-parentage pattern as embedded.test.ts.
import { describe, it, expect, afterEach, vi } from "vitest";

// Mutable fake parentage: the getter always reads the current value.
let parentWindow: unknown = window;
const installParentGetter = () => {
  Object.defineProperty(window, "parent", { configurable: true, get: () => parentWindow });
};

afterEach(() => {
  parentWindow = window;
  installParentGetter();
});

// Fresh ui.ts module graph, so signal initializers and the module-level
// createRoot(back-bind) effects re-run under the CURRENT parentage. Seeds a
// fresh null-state history entry first: jsdom's history is shared across this
// file's tests, so a clean base makes "no token in history.state" assert
// exactly "THIS import pushed nothing".
const freshUi = async () => {
  window.history.pushState(null, "");
  vi.resetModules();
  return await import("../../src/ui");
};

// Let Solid's standalone-root effects (the backStack binds) flush before
// asserting on history state.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const backToken = (state: unknown): string | null =>
  state && typeof state === "object" && typeof (state as { vhBack?: unknown }).vhBack === "string"
    ? (state as { vhBack: string }).vhBack
    : null;

describe("terminal dock default presentation (S1b)", () => {
  it("standalone: first open stays docked (termFull false); updater-form setters keep working", async () => {
    parentWindow = window;
    installParentGetter();
    const ui = await freshUi();
    // App.tsx opens the dock via the updater form (Ctrl+` / sidebar button).
    ui.setTermOpen((v) => !v);
    expect(ui.termOpen()).toBe(true);
    expect(ui.termFull()).toBe(false); // bottom-dock default — unchanged
    // TerminalDock's toggle uses the updater form too.
    ui.setTermFull((v) => !v);
    expect(ui.termFull()).toBe(true);
    ui.setTermFull((v) => !v);
    expect(ui.termFull()).toBe(false);
  });

  it("embedded: no full state and no back token before open; first open presents overlay-full", async () => {
    parentWindow = { postMessage: () => {} } as unknown as Window;
    installParentGetter();
    const ui = await freshUi();
    expect(ui.termFull()).toBe(false); // not full at load …
    await flush();
    expect(backToken(window.history.state)).toBeNull(); // … and NO phantom back entry
    ui.setTermOpen(true);
    expect(ui.termOpen()).toBe(true);
    expect(ui.termFull()).toBe(true); // the embedded default — the crux
  });

  it("embedded: an explicit Dock choice wins over the default for the session (survives close/reopen)", async () => {
    parentWindow = { postMessage: () => {} } as unknown as Window;
    installParentGetter();
    const ui = await freshUi();
    ui.setTermOpen(true); // default applies: full
    ui.setTermFull(false); // user clicks "Dock"
    ui.setTermOpen(false); // close the dock
    ui.setTermOpen(true); // reopen — the choice persists for the session
    expect(ui.termFull()).toBe(false);
  });

  it("design pin: a signal INITIALIZED true would push a back token at bind time — why the default applies at first open, not signal init", async () => {
    // Simulates the alternative mechanism (createSignal(isEmbedded()) — true
    // when embedded) against the SAME bindBackDismiss wiring ui.ts installs:
    // the bind's effect sees open() === true on its first run and pushes a
    // URL-transparent history entry at every embedded LOAD, before any
    // terminal is open — the first back press is then swallowed dismissing an
    // invisible surface. If this pin ever fails (binds no longer push at
    // init), the simpler signal-init default may be reconsidered.
    const { createRoot, createSignal } = await import("solid-js");
    const { bindBackDismiss, __resetBackStackForTest } = await import("../../src/lib/backStack");
    const [sig, setSig] = createSignal(true);
    createRoot(() => bindBackDismiss(sig, () => setSig(false), "pinfull"));
    await flush();
    expect(backToken(window.history.state)).toMatch(/^pinfull#/);
    __resetBackStackForTest();
  });
});
