import { expect, test, type Frame, type Page } from "@playwright/test";
import { projectUrl } from "./util";

// Exactly-once THEME PUSH DELIVERY to mounted frames — the lane-6 coverage the
// push-consolidation review DEFERred (T1B-F1/T1D-F1, commit 54feda6): unit
// tests prove the onThemeApplied registry seam in isolation, and
// theme-cross-tab.spec.ts proves the RECEIVING document side, but nothing
// asserted that a theme CHANGE in the mounted app actually delivers
//   (a) {source:"vh-solara", type:"theme"} to a mounted embedded-view iframe
//       (themeTokens.ts broadcastTheme → every iframe.view-frame), and
//   (b) the vh-code:theme nudge to the framed code viewer
//       (code/frame.ts postCodeTheme via postToCodeFrame),
// each EXACTLY ONCE per change. The registry fans out at the end of every
// applyTheme() (theme.ts), and index.tsx registers the push helpers once at
// boot — a double registration or a stray second fan-out path would
// double-deliver, which is precisely the regression shape under test.
//
// Topology: ONE page (no cross-tab storage topology needed). BOTH frame kinds
// alive simultaneously — the code dock (opened via a real filepath click; the
// parent<->child ready handshake is proven complete by the parser.go tab) and
// a registered embedded view. The view iframe is pointed at an unreachable
// upstream (127.0.0.1:9, the views.spec.ts convention) but its document is
// supplied by route interception: an INERT page whose inline script arms the
// message recorder during parse — i.e. BEFORE the iframe's load event, hence
// before ViewFrame.onLoad's boot push can land — with no SPA noise inside.
//
// Counters are armed INSIDE each frame context before any theme change. All
// assertions are DELTA-based from a post-arm baseline: boot pushes are NOT
// part of the exactly-once claim (ViewFrame.onLoad pushes tokens directly,
// not via the registry; the claim under test is per CHANGE), so the view
// frame's baseline is only polled to >=1 (boot push landed) and then
// snapshotted, and the code frame's recorder is armed after its ready
// handshake so its own boot-time applyTheme is invisible to the counter.
//
// Change route: the REAL Settings UI (Settings dialog → ThemePicker listbox →
// role=option click → setThemeId → ONE applyTheme → registry fan-out), never
// a direct setThemeId/localStorage write. Theme is per-context client state —
// this spec mutates NO shared fixture state (no pins/labels resets needed).
// The /vh/views registration IS server-side state: unregistered in finally so
// it cannot leak into sibling specs (the serial lane shares one backend).
//
// If the exactly-once assertions turn deterministically red here, that is a
// PRODUCT bug (double delivery), not a spec bug — stop and report; this spec
// intentionally has no tolerance for duplicate pushes.
//
// Service workers are BLOCKED in the spec-owned context: the PWA's sw.js
// respondWith-claims every same-origin GET outside /vh/, /oc/, / and /host/*
// (sw.js fetch handler) — including iframe NAVIGATION requests — and its
// network-first passthrough re-fetches from inside the worker, which
// page.route cannot see. Existing specs route only /vh/* API paths (excluded
// from the SW); this spec must intercept the view frame's navigation, so the
// SW has to be out of the path. The SW is orthogonal to the postMessage claim
// under test; blocking registration changes nothing about theme delivery.

const VIEW_ID = "theme-push";
const VIEW_TITLE = "Theme Push View";
const PATH_PREFIX = "/theme-push-view";

// The stable published token set (themeTokens.ts THEME_TOKENS) — every
// delivered theme payload must carry exactly these keys, sorted the way
// Object.keys().sort() orders them.
const TOKEN_KEYS = [
  "--vh-accent",
  "--vh-accent-2",
  "--vh-bg",
  "--vh-border",
  "--vh-error",
  "--vh-fg",
  "--vh-muted",
  "--vh-ok",
  "--vh-surface",
  "--vh-warn",
];

// The inert embedded-view document served for PATH_PREFIX. The recorder runs
// during parse, before the load event, so even the parent's boot push is
// captured deterministically (it becomes the baseline, not a change delta).
const INERT_VIEW_DOC = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${VIEW_TITLE}</title></head>
<body>
<div id="marker">${VIEW_TITLE}</div>
<script>
  (function () {
    var msgs = [];
    window.__vhThemeMsgs = msgs;
    window.addEventListener("message", function (ev) {
      var d = ev && ev.data;
      if (d && typeof d === "object" && d.source === "vh-solara" && d.type === "theme") {
        msgs.push({
          mode: d.mode,
          tokenKeys: d.tokens ? Object.keys(d.tokens).sort() : [],
          origin: ev.origin
        });
      }
    });
  })();
</script>
</body>
</html>`;

// One captured {source:"vh-solara", type:"theme"} message in the view frame.
interface CapturedViewThemeMsg {
  mode: string;
  tokenKeys: string[];
  origin: string;
}

// applyTheme() removes every `theme-<id>` class and adds exactly one, but
// <html> also carries UNRELATED classes (chat-bubbles, pane-visibility), so
// anchor at class boundaries — and keep `theme-light` from matching the
// `theme-light-scoped` marker (copied from theme-cross-tab.spec.ts).
function themeClassRe(id: string): RegExp {
  return new RegExp(`(?:^|\\s)theme-${id}(?:\\s|$)`);
}
const LIGHT_SCOPED_RE = /(?:^|\s)theme-light-scoped(?:\s|$)/;

function findFrame(page: Page, pattern: RegExp): Frame | null {
  return page.frames().find((f) => pattern.test(f.url())) ?? null;
}

// Matches the view frame's committed URL (…/theme-push-view/). PATH_PREFIX has
// no regex metacharacters (hyphens are literal outside character classes).
const viewUrlRe = new RegExp(PATH_PREFIX + "/");

// Count of vh-solara theme messages recorded so far inside the view frame.
// Returns -1 while the frame (or its recorder) is not reachable yet.
async function viewMsgCount(page: Page): Promise<number> {
  const f = findFrame(page, viewUrlRe);
  return f ? readCount(f, "__vhThemeMsgs") : -1;
}

async function codeMsgCount(page: Page): Promise<number> {
  const f = findFrame(page, /standalone=code/);
  return f ? readCount(f, "__vhCodeThemeMsgs") : -1;
}

async function readCount(frame: Frame, key: string): Promise<number> {
  try {
    return await frame.evaluate(
      (k) => {
        const arr = (window as unknown as Record<string, unknown>)[k];
        return Array.isArray(arr) ? arr.length : -1;
      },
      key,
    );
  } catch {
    return -1; // frame navigating/destroyed — poll again
  }
}

test("a theme change pushes tokens to the mounted view frame and the code frame exactly once each", async ({
  browser,
  request,
}) => {
  // Spec-owned context: (a) serviceWorkers blocked so page.route owns the view
  // frame's navigation (see the header note), (b) fresh localStorage (default
  // dark theme). Closed in finally — a leaked context keeps SSE connections
  // open and can perturb later broadcast assertions (theme-cross-tab.spec.ts
  // precedent).
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const page = await ctx.newPage();

  // The inert doc must be in place before the view iframe ever loads.
  await page.route(viewUrlRe, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: INERT_VIEW_DOC }),
  );

  try {
    await page.goto(projectUrl("/"));

    // Register the embedded view (server-side state; removed in finally).
    await page.evaluate(
      async ([viewId, title, prefix]) => {
        await fetch("/vh/views", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
          body: JSON.stringify({
            view_id: viewId,
            title,
            path_prefix: prefix,
            upstream: "http://127.0.0.1:9",
            sandbox: "allow-scripts allow-same-origin",
          }),
        });
      },
      [VIEW_ID, VIEW_TITLE, PATH_PREFIX],
    );
    // The SPA refreshes the view list on mount — reload to pick up the new one.
    await page.reload();
    // Boot settled on the default dark theme (fresh context = clean storage).
    await expect(page.locator("html")).toHaveClass(themeClassRe("dark"));
    await expect(page.locator("html")).not.toHaveClass(LIGHT_SCOPED_RE);

    // ── Mount the code frame: real filepath click (codeview.spec.ts path). ──
    await page.getByRole("button", { name: /Demo session/ }).click();
    // Shared Demo session: earlier specs append turns that window the original
    // messages (the ones carrying the clickable .filepath) out of the DOM —
    // scroll to the top to surface them.
    await page.locator(".chat-scroll").evaluate((el: HTMLElement) => (el.scrollTop = 0));
    await page.locator(".filepath", { hasText: "src/parser.go" }).first().click();
    await expect(page.locator(".code-dock.dock, .code-dock.overlay")).toBeVisible({ timeout: 6000 });
    // parser.go tab visible == parent<->child ready handshake COMPLETE (the
    // open command crossed the frame boundary), so postCodeTheme is live.
    const code = page.frameLocator('iframe[title="Code"]');
    await expect(code.locator(".code-tab-name", { hasText: "parser.go" })).toBeVisible({ timeout: 8000 });

    // ── Mount the view frame (code dock stays open: sibling in .main-body). ──
    await page.getByRole("button", { name: VIEW_TITLE, exact: true }).click();
    const viewFrameEl = page.locator("iframe.view-frame");
    await expect(viewFrameEl).toHaveCount(1);
    await expect(viewFrameEl).toHaveAttribute("src", `${PATH_PREFIX}/`);

    // Arm the code-frame recorder AFTER the ready handshake (its own boot-time
    // applyTheme never registers the push helpers — standalone branch — so it
    // cannot self-deliver; the guard makes re-arming idempotent).
    const codeF = findFrame(page, /standalone=code/);
    if (!codeF) throw new Error("code frame not found after ready handshake");
    await codeF.evaluate(() => {
      const w = window as unknown as { __vhCodeArmed?: boolean; __vhCodeThemeMsgs?: { origin: string }[] };
      if (w.__vhCodeArmed) return;
      w.__vhCodeArmed = true;
      w.__vhCodeThemeMsgs = [];
      window.addEventListener("message", (ev: MessageEvent) => {
        const d = ev.data as { type?: string } | null;
        if (d && typeof d === "object" && d.type === "vh-code:theme") {
          w.__vhCodeThemeMsgs!.push({ origin: ev.origin });
        }
      });
    });

    // View-frame recorder comes from the inert doc itself; wait until it is
    // reachable, then wait for the boot push (>=1) and snapshot both baselines.
    await expect
      .poll(async () => {
        const f = findFrame(page, viewUrlRe);
        if (!f) return false;
        try {
          return await f.evaluate(() => Array.isArray((window as unknown as { __vhThemeMsgs?: unknown[] }).__vhThemeMsgs));
        } catch {
          return false;
        }
      }, { timeout: 10_000 })
      .toBe(true);
    await expect.poll(() => viewMsgCount(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    // Let any late boot-time chatter settle, then snapshot the baselines.
    await page.waitForTimeout(500);
    const viewBaseline = await viewMsgCount(page);
    const codeBaseline = await codeMsgCount(page);
    test.info().annotations.push({
      type: "baselines",
      description: `view-frame=${viewBaseline} (boot push), code-frame=${codeBaseline} (armed post-handshake)`,
    });
    const appOrigin = new URL(page.url()).origin;

    // ── Theme change 1: dark → light via the REAL Settings UI. ──────────────
    await page.getByRole("button", { name: "Settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    const picker = dialog.getByRole("listbox", { name: "Theme" });
    await expect(picker.getByRole("option", { name: "Nord" })).toBeVisible();
    // exact:true — "Light" is a substring of "One Light"/"Shire (light)".
    await picker.getByRole("option", { name: "Light", exact: true }).click();

    // The parent applied locally: class flip + light marker.
    await expect(page.locator("html")).toHaveClass(themeClassRe("light"));
    await expect(page.locator("html")).toHaveClass(LIGHT_SCOPED_RE);

    // THE CLAIM: exactly ONE delivery per frame per change.
    await expect.poll(() => viewMsgCount(page), { timeout: 5_000 }).toBe(viewBaseline + 1);
    await expect.poll(() => codeMsgCount(page), { timeout: 5_000 }).toBe(codeBaseline + 1);

    // Payload coherence (view frame): mode matches the chosen theme, the full
    // stable token set, same-origin sender.
    const viewF = findFrame(page, viewUrlRe);
    if (!viewF) throw new Error("view frame lost before payload read");
    const lightMsgs = (await viewF.evaluate(
      () => (window as unknown as { __vhThemeMsgs: CapturedViewThemeMsg[] }).__vhThemeMsgs,
    )) as CapturedViewThemeMsg[];
    expect(lightMsgs).toHaveLength(viewBaseline + 1);
    const lightMsg = lightMsgs[lightMsgs.length - 1];
    expect(lightMsg.mode).toBe("light");
    expect(lightMsg.tokenKeys).toEqual(TOKEN_KEYS);
    expect(lightMsg.origin).toBe(appOrigin);

    const lightCodeMsgs = (await codeF.evaluate(
      () => (window as unknown as { __vhCodeThemeMsgs: { origin: string }[] }).__vhCodeThemeMsgs,
    )) as { origin: string }[];
    expect(lightCodeMsgs).toHaveLength(codeBaseline + 1);
    expect(lightCodeMsgs[lightCodeMsgs.length - 1].origin).toBe(appOrigin);

    // ── Idle: no further deliveries without another change. ─────────────────
    await page.waitForTimeout(700);
    expect(await viewMsgCount(page)).toBe(viewBaseline + 1);
    expect(await codeMsgCount(page)).toBe(codeBaseline + 1);

    // ── Theme change 2: light → dracula — exactly one MORE of each. ─────────
    await picker.getByRole("option", { name: "Dracula", exact: true }).click();
    await expect(page.locator("html")).toHaveClass(themeClassRe("dracula"));
    await expect(page.locator("html")).not.toHaveClass(LIGHT_SCOPED_RE);

    await expect.poll(() => viewMsgCount(page), { timeout: 5_000 }).toBe(viewBaseline + 2);
    await expect.poll(() => codeMsgCount(page), { timeout: 5_000 }).toBe(codeBaseline + 2);

    const darkMsgs = (await viewF.evaluate(
      () => (window as unknown as { __vhThemeMsgs: CapturedViewThemeMsg[] }).__vhThemeMsgs,
    )) as CapturedViewThemeMsg[];
    expect(darkMsgs).toHaveLength(viewBaseline + 2);
    expect(darkMsgs[darkMsgs.length - 1].mode).toBe("dark");
    expect(darkMsgs[darkMsgs.length - 1].tokenKeys).toEqual(TOKEN_KEYS);

    const darkCodeMsgs = (await codeF.evaluate(
      () => (window as unknown as { __vhCodeThemeMsgs: { origin: string }[] }).__vhCodeThemeMsgs,
    )) as { origin: string }[];
    expect(darkCodeMsgs).toHaveLength(codeBaseline + 2);
  } finally {
    // Unregister so the server-side view registration cannot leak into other
    // specs (serial lane, one shared fixtureserver). Best-effort: cleanup must
    // not mask the test's own failure.
    await request
      .delete(`/vh/views?view_id=${VIEW_ID}`, { headers: { "X-VH-CSRF": "1" } })
      .catch(() => undefined);
    await ctx.close();
  }
});
