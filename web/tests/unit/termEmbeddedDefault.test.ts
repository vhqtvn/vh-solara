// @vitest-environment jsdom
//
// Terminal-dock DEFAULT presentation (web/src/ui.ts): docked-first in ALL
// contexts — standalone AND embedded (host shell iframe). This REVERSES the
// earlier S1b embedded default (first embedded open forced overlay-full) at
// operator request: the first terminal open now presents the small bottom
// dock everywhere; overlay-full (.full) is an explicit user action via the
// Dock/Full-screen toggle, and the choice is session-scoped (never
// persisted).
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

describe("terminal dock default presentation (docked-first; S1b full-first reversed)", () => {
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

  it("embedded: no full state and no back token before open; first open stays DOCKED", async () => {
    parentWindow = { postMessage: () => {} } as unknown as Window;
    installParentGetter();
    const ui = await freshUi();
    expect(ui.termFull()).toBe(false); // not full at load …
    await flush();
    expect(backToken(window.history.state)).toBeNull(); // … and NO phantom back entry
    ui.setTermOpen(true);
    expect(ui.termOpen()).toBe(true);
    expect(ui.termFull()).toBe(false); // docked-first in the iframe too — the crux (S1b reversed)
  });

  it("embedded: an explicit Full choice persists for the session (survives close/reopen)", async () => {
    parentWindow = { postMessage: () => {} } as unknown as Window;
    installParentGetter();
    const ui = await freshUi();
    ui.setTermOpen(true); // opens docked
    ui.setTermFull(true); // user clicks "Full screen"
    ui.setTermOpen(false); // close the dock
    ui.setTermOpen(true); // reopen — still full: the choice persists for the session
    expect(ui.termFull()).toBe(true);
  });

  it("design pin: a signal INITIALIZED true would push a back token at bind time — why termFull must init false", async () => {
    // Simulates the rejected alternative (createSignal(true)) against the
    // SAME bindBackDismiss wiring ui.ts installs: the bind's effect sees
    // open() === true on its first run and pushes a URL-transparent history
    // entry at every LOAD, before any terminal is open — the first back press
    // is then swallowed dismissing an invisible surface. Docked-first (init
    // false) is both the desired default everywhere and the only init that
    // pushes no phantom token. If this pin ever fails (binds no longer push
    // at init), the mechanism note needs revisiting.
    const { createRoot, createSignal } = await import("solid-js");
    const { bindBackDismiss, __resetBackStackForTest } = await import("../../src/lib/backStack");
    const [sig, setSig] = createSignal(true);
    createRoot(() => bindBackDismiss(sig, () => setSig(false), "pinfull"));
    await flush();
    expect(backToken(window.history.state)).toMatch(/^pinfull#/);
    __resetBackStackForTest();
  });
});
