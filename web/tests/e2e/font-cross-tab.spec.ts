import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { projectUrl } from "./util";

// Cross-TAB font synchronization — the font twin of theme-cross-tab.spec.ts,
// closing its review DEFER (slice-B c-F1/d-F1): commit 47b4305 landed the
// font.ts onRemoteChange wiring, but the cross-tab proof lived only at the
// jsdom unit seam (a SYNTHETIC StorageEvent inside ONE document), which
// cannot prove that (1) a real browser delivers the `storage` event for the
// three font keys to the other same-origin document, (2) the receiving
// document re-applies the imperative font WITHOUT a reload (--font-ui /
// --font-mono inline vars on <html> + on-demand Google-Fonts <link>
// injection), and (3) the custom-family edit re-applies live while "custom"
// is the ACTIVE font (font.ts's conditional onRemoteChange).
//
// Topology: identical to the theme spec — pages A and B in the SAME browser
// context (shared origin localStorage, mutual `storage` events; two separate
// contexts would NOT share storage). A storage listener armed in B before
// every change records {key, isTrusted, newValue}; browser-delivered events
// are isTrusted:true, only font.ts's frozen-tab catch-up dispatches
// isTrusted:false ones.
//
// Honest observables (per font.ts's actual apply mechanics — no xterm
// internals: TerminalPane reads monoFontStack() at creation only, a
// pre-existing pull behavior this spec must not poke):
//   - UI font: the inline `--font-ui` custom property on <html> (exactly
//     what applyFont() writes), read via getComputedStyle so the value is
//     the live CSSOM one; plus getComputedStyle(document.body).fontFamily —
//     body { font-family: var(--font-ui) } (legacy 80-professional-pass.css)
//     — to prove the var lands in the CASCADE, not just on the property.
//     The stack is a specified family LIST, so this is honest even when the
//     webfont itself never loads (sandboxed network): the var + computed
//     stack never depend on font availability.
//   - Webfont injection: presence (not load success) of the
//     fonts.googleapis.com <link> in B — ensureWebfont() appends the element
//     synchronously inside applyFont(); element presence is network-free.
//   - Mono font: the inline `--font-mono` var on <html>.
//
// Change route: the REAL settings UI in A (Settings → Appearance → the
// "Display font" / "Code font" custom Selects and the "Custom font family"
// input), never a direct localStorage write. fill() on the custom input
// fires exactly ONE input event → one setCustomFont → one storage event.
//
// No-reload proof: a random sentinel on B's window + B's URL unchanged.
//
// Refocus catch-up: font.ts re-runs the storage-event path on becoming
// visible by dispatching SYNTHETIC StorageEvents (isTrusted:false) for ALL
// THREE font keys. Asserted only when B genuinely transitioned hidden→visible
// (bringToFront in a HEADED run flips real visibility; Playwright's
// headless-shell keeps background pages "visible", so there is no transition
// to observe — recorded via annotation, never flakily asserted). That
// headless limitation is exactly why the catch-up poll assertions have never
// executed in CI (slice-C review a-F1/b-F1/d-F2); the headed attempt is
// tracked separately.
//
// Test hygiene: theme/font prefs are per-context localStorage state — this
// spec mutates NO shared fixture backend state. The manually-created context
// MUST be closed in finally (a leaked context keeps SSE connections open).

const FONT_KEY = "vh.font.v1";
const CUSTOM_KEY = "vh.font.custom.v1";
const MONO_KEY = "vh.font.mono.v1";

// Stack constants mirrored from web/src/font.ts (FONTS/MONO_FONTS entries).
// Asserting EXACT equality pins that the remote apply wrote precisely the
// def's stack, not a stale or partial one.
const SYS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const INTER_STACK = `"Inter", ${SYS}`;
const MONO_SYS = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';
const FIRA_CODE_STACK = `"Fira Code", ${MONO_SYS}`;
// A clearly-synthetic family name: nothing on the host provides it, which is
// irrelevant to the var assertion (a stack is a specified list) but makes the
// custom-family phase unmaskable by any real font coincidence.
const CUSTOM_FAMILY = "Vonk Axion";
const CUSTOM_STACK = `"${CUSTOM_FAMILY}", ${SYS}`;

// Captured shape of one storage event observed in the receiving page.
interface CapturedStorageEvent {
  key: string | null;
  isTrusted: boolean;
  newValue: string | null;
}

// Open one more page IN THE GIVEN CONTEXT (shared-localStorage topology) and
// wait for the app to boot: index.tsx calls applyFont()+applyMonoFont() at
// module init, right next to applyTheme() (whose theme-dark class is the
// boot marker the theme spec already proved) — so by the time the class is
// there, the font vars are too, and the baseline reads below are race-free.
async function openAppPage(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(projectUrl("/"));
  await expect(page.locator("html")).toHaveClass(/(?:^|\s)theme-dark(?:\s|$)/);
  return page;
}

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

// The live CSSOM value of one font var on <html> (what applyFont/
// applyMonoFont imperatively write via style.setProperty).
function fontVar(page: Page, name: "--font-ui" | "--font-mono"): Promise<string> {
  return page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
}

// body consumes var(--font-ui) (legacy 80-professional-pass.css), so its
// computed fontFamily proves the new stack reached the cascade.
function bodyFontFamily(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).fontFamily);
}

// How many on-demand Google-Fonts <link>s for `familyQuery` sit in <head>.
// Presence only — the element is appended synchronously by ensureWebfont();
// whether the stylesheet actually loads is network-dependent and NOT part of
// the sync contract under test.
function fontLinkCount(page: Page, familyQuery: string): Promise<number> {
  return page.evaluate(
    (q) => Array.from(document.querySelectorAll(`link[rel="stylesheet"][href*="${q}"]`)).length,
    familyQuery,
  );
}

test("font change in tab A reaches tab B live via a real storage event, no reload", async ({ browser }) => {
  const ctx = await browser.newContext();
  try {
    // Both pages in ONE context. B is opened last (starts as the front
    // page); A is backgrounded until armed, then brought front to edit.
    const a = await openAppPage(ctx);
    const b = await openAppPage(ctx);
    const bUrl = b.url();

    // Baseline: both documents boot on the system stacks (fresh context →
    // empty storage → defaults "system" / "system-mono").
    expect(await fontVar(a, "--font-ui")).toBe(SYS);
    expect(await fontVar(b, "--font-ui")).toBe(SYS);
    expect(await fontVar(a, "--font-mono")).toBe(MONO_SYS);
    expect(await fontVar(b, "--font-mono")).toBe(MONO_SYS);

    const sentinel = `alive-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await armReceiver(b, sentinel);

    // The real settings UI in A. Fonts live in the "Appearance" section
    // (SettingsDialog sections()); the Display/Code font controls are the
    // custom Select (portaled popup — options are role=option on <body>).
    await a.bringToFront();
    await a.getByRole("button", { name: "Settings" }).click();
    const dialog = a.getByRole("dialog", { name: "Settings" });
    await dialog.getByRole("button", { name: "Appearance" }).click();
    const displayFont = dialog.getByLabel("Display font");
    const codeFont = dialog.getByLabel("Code font");
    await expect(displayFont).toBeVisible();
    await expect(codeFont).toBeVisible();

    // ── Phase 0: record B's background state for the catch-up gate ──────
    // (A is the front page now; in a headed run B is hidden, in
    // headless-shell it stays "visible" — see the header note.)
    const wasHidden = await b.evaluate(() => document.visibilityState === "hidden");
    test.info().annotations.push({
      type: "background-tab",
      description: `B document.visibilityState while A was front: ${wasHidden ? "hidden" : "visible"}`,
    });

    // ── Phase 1: UI font system → Inter (a webfont def) with B in the ────
    // background. A real (non-frozen) background tab still receives
    // `storage` events — deterministic in desktop Chromium.
    let captured = await captureCount(b);
    await displayFont.click();
    await a.getByRole("option", { name: "Inter", exact: true }).click();

    // A applies locally (the writer never receives its own storage event).
    expect(await fontVar(a, "--font-ui")).toBe(INTER_STACK);
    // The local webfont <link> injection (ensureWebfont in A).
    expect(await fontLinkCount(a, "family=Inter")).toBe(1);
    // B re-applies WITHOUT any reload: real storage event (isTrusted:true)
    // → persistedSignal re-read → onRemoteChange → applyFont(). B-side reads
    // POLL (the theme spec's discipline): the storage event is delivered to
    // B asynchronously, so the remote apply lands a beat after A's local
    // one — poll until the exact expected value (never loosen the assert).
    await expect.poll(() => fontVar(b, "--font-ui")).toBe(INTER_STACK);
    // …and the new stack reaches the RECEIVING document's cascade. Chromium's
    // computed font-family serialization DROPS quotes around single-word
    // family names ("Inter" → Inter) while keeping them for multi-word ones,
    // so anchor the first family token with both quote forms accepted.
    await expect.poll(() => bodyFontFamily(b)).toMatch(/^"?Inter"?,/);
    // …and the on-demand webfont <link> is injected remotely (element
    // presence — network-free, see header).
    await expect.poll(() => fontLinkCount(b, "family=Inter")).toBe(1);
    const interEvents = await capturedEvents(b, captured);
    expect(
      interEvents.filter((e) => e.key === FONT_KEY && e.isTrusted && e.newValue?.includes("inter")),
    ).toHaveLength(1);

    // ── Phase 2: mono font system-mono → Fira Code ───────────────────────
    // The honest mono observable is the --font-mono var (applyMonoFont's
    // write). xterm terminals read monoFontStack() at CREATION only — a
    // pre-existing pull behavior deliberately NOT asserted here.
    captured = await captureCount(b);
    await codeFont.click();
    await a.getByRole("option", { name: "Fira Code", exact: true }).click();

    expect(await fontVar(a, "--font-mono")).toBe(FIRA_CODE_STACK);
    await expect.poll(() => fontVar(b, "--font-mono")).toBe(FIRA_CODE_STACK);
    await expect.poll(() => fontLinkCount(b, "family=Fira+Code")).toBe(1);
    const monoEvents = await capturedEvents(b, captured);
    expect(
      monoEvents.filter((e) => e.key === MONO_KEY && e.isTrusted && e.newValue?.includes("fira-code")),
    ).toHaveLength(1);

    // ── Phase 3: custom font — activate "custom", then edit the family ──
    // Selecting "Custom (system font)" with an EMPTY family keeps the stack
    // at SYS (font.ts's fallback); the interesting remote path is the family
    // edit WHILE custom is active in both documents.
    captured = await captureCount(b);
    await displayFont.click();
    await a.getByRole("option", { name: "Custom (system font)", exact: true }).click();

    // B follows the activation (stack still SYS — family empty). The value
    // poll is degenerate here (SYS was already the live value) but keeps the
    // uniform B-side poll discipline; the ACTIVATION proof is the captured
    // storage event below.
    await expect.poll(() => fontVar(b, "--font-ui")).toBe(SYS);
    const customEvents = await capturedEvents(b, captured);
    expect(
      customEvents.filter((e) => e.key === FONT_KEY && e.isTrusted && e.newValue?.includes("custom")),
    ).toHaveLength(1);

    // The custom-family row appears only while font()==="custom". fill()
    // fires ONE input event → ONE setCustomFont → ONE storage write.
    captured = await captureCount(b);
    const familyInput = dialog.getByLabel("Custom font family");
    await familyInput.fill(CUSTOM_FAMILY);

    // A applies locally (setCustomFont's conditional apply).
    expect(await fontVar(a, "--font-ui")).toBe(CUSTOM_STACK);
    // B re-applies live: font() === "custom" there too, so customFont's
    // onRemoteChange conditional apply fires (the exact branch 47b4305
    // wired; previously a remote family edit did nothing until reload).
    await expect.poll(() => fontVar(b, "--font-ui")).toBe(CUSTOM_STACK);
    await expect.poll(() => bodyFontFamily(b)).toMatch(/^"?Vonk Axion"?,/);
    const familyEvents = await capturedEvents(b, captured);
    expect(
      familyEvents.filter((e) => e.key === CUSTOM_KEY && e.isTrusted && e.newValue?.includes(CUSTOM_FAMILY)),
    ).toHaveLength(1);

    // ── Phase 4: refocus B — the frozen-tab visibilitychange catch-up ────
    // font.ts re-runs the storage-event path on becoming visible by
    // dispatching SYNTHETIC StorageEvents (isTrusted:false) for ALL THREE
    // font keys. Idempotent by design: B must stay on the custom stack with
    // no flicker away. Only assert the catch-up when B genuinely transitioned
    // hidden→visible (see header note — this is the branch that has never
    // executed under headless-shell).
    captured = await captureCount(b);
    await b.bringToFront();
    expect(await fontVar(b, "--font-ui")).toBe(CUSTOM_STACK);
    expect(await fontVar(b, "--font-mono")).toBe(FIRA_CODE_STACK);
    if (wasHidden) {
      // Poll (not a one-shot read): the visibilitychange handler runs
      // asynchronously after bringToFront resolves.
      await expect
        .poll(async () => {
          const catchUp = await capturedEvents(b, captured);
          const keys = new Set(catchUp.filter((e) => !e.isTrusted).map((e) => e.key));
          return [keys.has(FONT_KEY), keys.has(CUSTOM_KEY), keys.has(MONO_KEY)];
        })
        .toEqual([true, true, true]);
    } else {
      test.info().annotations.push({
        type: "catch-up-skipped",
        description: "background page stayed 'visible' in this environment; no hidden→visible transition to exercise",
      });
    }

    // ── No-reload proof: B's sentinel + URL survived every transition. ──
    expect(await b.evaluate(() => (window as unknown as { __crossTabSentinel?: string }).__crossTabSentinel)).toBe(sentinel);
    expect(b.url()).toBe(bUrl);
  } finally {
    await ctx.close();
  }
});
