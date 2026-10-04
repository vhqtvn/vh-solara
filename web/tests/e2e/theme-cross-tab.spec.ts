import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { projectUrl } from "./util";

// Cross-TAB theme synchronization — the real-browser, two-document coverage the
// theme-sync commit review DEFERred (a-F3/b-F1/c-F1/d-F3): the existing
// web/tests/unit/theme.test.ts proves the storage-event handler with a SYNTHETIC
// StorageEvent dispatched inside ONE jsdom document, which cannot prove that
// (1) a real browser delivers the `storage` event to the other same-origin
// document at all, (2) the receiving document re-applies the imperative
// theme WITHOUT a reload, and (3) the light/dark boundary marker
// (.theme-light-scoped) flips coherently on the remote side.
//
// Topology: pages A and B live in the SAME browser context (one ctx.newPage()
// each). Same-context pages share origin localStorage and receive each other's
// `storage` events; two separate contexts would NOT share storage — that
// isolation is the one trap this spec must not fall into (pins/labels
// multiclient specs deliberately use SEPARATE contexts because they test
// SERVER-broadcast state; theme is client-local storage state).
//
// Real-event proof: a storage listener armed in B before every change records
// {key, isTrusted, newValue}. Browser-dispatched storage events are
// isTrusted:true; only the app's own frozen-tab catch-up (theme.ts
// visibilitychange handler) dispatches isTrusted:false StorageEvents — so the
// flag cleanly separates REAL cross-tab delivery from the synthetic catch-up
// path (which the refocus phase exercises as the stretch goal).
//
// Change route: the REAL settings UI in A (Settings dialog → ThemePicker →
// role=option click → setThemeId → persistedSignal writes vh.theme.v1), never a
// direct localStorage write.
//
// No-reload proof: a random sentinel set on B's window before the first
// change must still be present after the last one (any navigation would wipe
// it), plus B's URL is asserted unchanged.
//
// Test hygiene: the serial lane (workers:1) shares one fixtureserver; theme is
// per-context localStorage state, so this spec mutates NO shared fixture state
// (no pins/labels resets needed). The manually-created context MUST be closed
// in finally — a leaked context keeps SSE connections open and can perturb
// later broadcast assertions (see pins-multiclient.spec.ts).

const THEME_KEY = "vh.theme.v1";
const CUSTOM_KEY = "vh.theme.custom.v1";

// Captured shape of one storage event observed in the receiving page.
interface CapturedStorageEvent {
  key: string | null;
  isTrusted: boolean;
  newValue: string | null;
}

// Open one more page IN THE GIVEN CONTEXT (the shared-localStorage topology)
// and wait for the app to boot: applyTheme() stamps the default dark theme on
// <html> at module init, so `theme-dark` present == SPA booted.
async function openAppPage(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(projectUrl("/"));
  await expect(page.locator("html")).toHaveClass(themeClassRe("dark"));
  return page;
}

// applyTheme() removes every `theme-<id>` class and adds exactly one, but
// <html> also carries UNRELATED classes (chat-bubbles, pane-visibility), so
// anchor at class boundaries — and keep `theme-light` from matching the
// `theme-light-scoped` marker (and `theme-*` ids containing each other).
function themeClassRe(id: string): RegExp {
  return new RegExp(`(?:^|\\s)theme-${id}(?:\\s|$)`);
}
const LIGHT_SCOPED_RE = /(?:^|\s)theme-light-scoped(?:\s|$)/;

// Arm B's storage-event recorder (BEFORE any remote change) and stamp the
// no-reload sentinel.
async function armReceiver(page: Page, sentinel: string): Promise<void> {
  await page.evaluate(
    ({ s }) => {
      const w = window as unknown as { __crossTabSentinel?: string; __storageEvents?: CapturedStorageEvent[] };
      w.__crossTabSentinel = s;
      w.__storageEvents = [];
      window.addEventListener("storage", (e) => {
        w.__storageEvents!.push({ key: e.key, isTrusted: e.isTrusted, newValue: e.newValue });
      });
    },
    { s: sentinel },
  );
}

async function capturedEvents(page: Page, since: number): Promise<CapturedStorageEvent[]> {
  return page.evaluate(
    (start) => {
      const w = window as unknown as { __storageEvents?: CapturedStorageEvent[] };
      return w.__storageEvents ? w.__storageEvents.slice(start) : [];
    },
    since,
  );
}

async function captureCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as { __storageEvents?: CapturedStorageEvent[] };
    return w.__storageEvents ? w.__storageEvents.length : 0;
  });
}

test("theme change in tab A reaches tab B live via a real storage event, no reload", async ({ browser }) => {
  const ctx = await browser.newContext();
  try {
    // Both pages in ONE context (see topology note above). B is opened last so
    // it starts as the front page; A is backgrounded until armed.
    const a = await openAppPage(ctx);
    const b = await openAppPage(ctx);
    const bUrl = b.url();

    // Baseline: both documents render the default dark theme, light marker off.
    await expect(a.locator("html")).not.toHaveClass(LIGHT_SCOPED_RE);
    await expect(b.locator("html")).not.toHaveClass(LIGHT_SCOPED_RE);

    const sentinel = `alive-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await armReceiver(b, sentinel);

    // The real settings UI in A. The dialog boots on the "Theme" section, so
    // the ThemePicker is already visible (SettingsDialog createSignal("theme")).
    // exact:true — "Light" is a substring of "One Light"/"Shire (light)".
    await a.bringToFront();
    await a.getByRole("button", { name: "Settings" }).click();
    const dialog = a.getByRole("dialog", { name: "Settings" });
    const picker = dialog.getByRole("listbox", { name: "Theme" });
    await expect(picker.getByRole("option", { name: "Nord" })).toBeVisible();

    // ── Phase 1: dark → nord (same-mode flip) with B BACKGROUNDed ───────────
    // Approximates the background-tab case (the stretch): A is the front page,
    // B hidden. A real (non-frozen) background tab still receives `storage`
    // events — deterministic in desktop Chromium, so this is asserted, not
    // best-effort.
    const wasHidden = await b.evaluate(() => document.visibilityState === "hidden");
    test.info().annotations.push({
      type: "background-tab",
      description: `B document.visibilityState while A was front: ${wasHidden ? "hidden" : "visible"}`,
    });

    let captured = await captureCount(b);
    await picker.getByRole("option", { name: "Nord", exact: true }).click();

    // A applies locally (no event needed — the writer never receives its own
    // storage event).
    await expect(a.locator("html")).toHaveClass(themeClassRe("nord"));
    // B flips WITHOUT any reload: the browser delivered a REAL storage event
    // (isTrusted:true) and persistedSignal's onRemoteChange ran applyTheme().
    await expect(b.locator("html")).toHaveClass(themeClassRe("nord"));
    await expect(b.locator("html")).not.toHaveClass(LIGHT_SCOPED_RE);
    expect(await b.evaluate(() => document.documentElement.style.colorScheme)).toBe("dark");
    const nordEvents = await capturedEvents(b, captured);
    expect(
      nordEvents.filter((e) => e.key === THEME_KEY && e.isTrusted && e.newValue?.includes("nord")),
    ).toHaveLength(1);

    // ── Phase 2: nord → light (dark→light boundary) still with B hidden ─────
    captured = await captureCount(b);
    await picker.getByRole("option", { name: "Light", exact: true }).click();

    await expect(b.locator("html")).toHaveClass(themeClassRe("light"));
    // The generic light marker flips ON remotely — the light syntax sheet +
    // light overrides must key off the RECEIVING document's class, not just
    // the writer's.
    await expect(b.locator("html")).toHaveClass(LIGHT_SCOPED_RE);
    expect(await b.evaluate(() => document.documentElement.style.colorScheme)).toBe("light");
    const lightEvents = await capturedEvents(b, captured);
    expect(
      lightEvents.filter((e) => e.key === THEME_KEY && e.isTrusted && e.newValue?.includes("light")),
    ).toHaveLength(1);

    // ── Phase 3: refocus B — the frozen-tab visibilitychange catch-up fires ──
    // theme.ts re-runs the storage-event path on becoming visible by
    // dispatching SYNTHETIC StorageEvents (isTrusted:false) for BOTH theme
    // keys. Idempotent by design: B must stay on theme-light with no flicker
    // away. Only assert the catch-up when B genuinely transitioned
    // hidden→visible (bringToFront in headless Chromium does flip
    // visibilityState; if an engine/environment keeps background pages
    // "visible", no visibilitychange fires and there is nothing to observe —
    // recorded via annotation rather than flakily asserted).
    captured = await captureCount(b);
    await b.bringToFront();
    await expect(b.locator("html")).toHaveClass(themeClassRe("light"));
    await expect(b.locator("html")).toHaveClass(LIGHT_SCOPED_RE);
    if (wasHidden) {
      // Poll (not a one-shot read): the visibilitychange handler runs
      // asynchronously after bringToFront resolves, so the synthetic events
      // can land a beat later than the (already-satisfied) class assertions.
      await expect
        .poll(async () => {
          const catchUp = await capturedEvents(b, captured);
          const keys = new Set(catchUp.filter((e) => !e.isTrusted).map((e) => e.key));
          return [keys.has(THEME_KEY), keys.has(CUSTOM_KEY)];
        })
        .toEqual([true, true]);
    } else {
      test.info().annotations.push({
        type: "catch-up-skipped",
        description: "background page stayed 'visible' in this environment; no hidden→visible transition to exercise",
      });
    }

    // ── Phase 4: light → dracula (light→dark boundary), B hidden again ──────
    await a.bringToFront();
    captured = await captureCount(b);
    await picker.getByRole("option", { name: "Dracula", exact: true }).click();

    await expect(b.locator("html")).toHaveClass(themeClassRe("dracula"));
    // The light marker flips OFF remotely (crossing back out of light mode).
    await expect(b.locator("html")).not.toHaveClass(LIGHT_SCOPED_RE);
    expect(await b.evaluate(() => document.documentElement.style.colorScheme)).toBe("dark");
    const draculaEvents = await capturedEvents(b, captured);
    expect(
      draculaEvents.filter((e) => e.key === THEME_KEY && e.isTrusted && e.newValue?.includes("dracula")),
    ).toHaveLength(1);

    // ── No-reload proof: B's sentinel + URL survived every transition. ──────
    expect(await b.evaluate(() => (window as unknown as { __crossTabSentinel?: string }).__crossTabSentinel)).toBe(sentinel);
    expect(b.url()).toBe(bUrl);
  } finally {
    await ctx.close();
  }
});
