// P1 portrait session monitor — the 48px session rail (narrow band, <560
// visual px) + drawer auto-close on select.
//
// The fixture serves the SPA standalone (zoom = 1, `.app` box = viewport), so
// page.setViewportSize drives the width tier end-to-end (RO on `.app` →
// visual-px classification → `data-w-tier`). The rail gates itself on
// `widthTier() === "narrow"`: 360/500 render it, 640 (rail band)/1280 (wide)
// never do, and the kill-switch (vh.prefs.shapeTier.v1 = "off") leaves the
// tier signal null so NOTHING renders and NOTHING auto-closes — the exact
// legacy drawer-only behavior.
//
// Chromium lane (the playwright.config.ts default; firefox is testMatch-
// scoped to codeview). Serial suite conventions (workers:1, one shared
// mutable fixture backend) apply: the states test creates its OWN session,
// answers its question, and acks its unread in cleanup so sibling specs
// (unread-dot especially) see an unperturbed backend.
import { expect, test } from "@playwright/test";
import { demoDir, projectUrl } from "./util";

const NARROW360 = { width: 360, height: 800 };
const NARROW500 = { width: 500, height: 800 };
const RAIL640 = { width: 640, height: 800 };
const WIDE1280 = { width: 1280, height: 800 };
// Evidence screenshots land in the gitignored repo tmp/ (playwright CWD is
// web/, so ../tmp is the repo's tmp — the rail.spec.ts convention).
const EVIDENCE = "../tmp/session-rail-evidence";

test("narrow band: 48px rail beside the chat — geometry, non-overlap, no horizontal scroll", async ({ page }) => {
  for (const vp of [NARROW360, NARROW500]) {
    await page.setViewportSize(vp);
    await page.goto(projectUrl("/?session=demo"));
    await expect(page.locator(".app")).toHaveAttribute("data-w-tier", "narrow");
    const rail = page.locator(".session-rail");
    await expect(rail).toBeVisible();
    const railBox = await rail.boundingBox();
    expect(railBox).toBeTruthy();
    expect(Math.round(railBox!.width)).toBe(48); // invariant: the 48px column

    // The chat fills the REMAINDER (adjacent flex column, never covered).
    // At 360: 360 - 48 = 312.
    const chat = page.locator(".chat");
    await expect(chat).toBeVisible();
    const chatBox = await chat.boundingBox();
    expect(chatBox).toBeTruthy();
    expect(chatBox!.x).toBeGreaterThanOrEqual(railBox!.x + railBox!.width - 1);
    expect(Math.round(chatBox!.width)).toBeCloseTo(vp.width - 48, 0);

    // No wrap / no horizontal scroll anywhere (the rail column is vertical-only).
    const overflowX = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflowX).toBeLessThanOrEqual(0);

    // Root avatars are present (demo/other/slow roots; the `sub` child never
    // enumerates — root granularity).
    await expect(rail.locator(".rail-avatar[data-session-id='demo']")).toBeVisible();
    await expect(rail.locator(".rail-avatar[data-session-id='other']")).toBeVisible();
    await expect(rail.locator(".rail-avatar[data-session-id='slow']")).toBeVisible();
    await expect(rail.locator(".rail-avatar[data-session-id='sub']")).toHaveCount(0);

    // Pinned foot: connection dot + drawer opener always present (the
    // needs-you badge is state-gated and asserted in the states test).
    await expect(rail.locator(".rail-conn")).toBeVisible();
    await expect(rail.locator(".rail-open")).toBeVisible();
  }
});

test("rail band and wide: no session rail — the existing presentations stand", async ({ page }) => {
  await page.setViewportSize(RAIL640);
  await page.goto(projectUrl("/?session=demo"));
  await expect(page.locator(".app")).toHaveAttribute("data-w-tier", "rail");
  await expect(page.locator(".session-rail")).toHaveCount(0);
  // The rail band's inline sidebar is what shows instead.
  await expect(page.locator(".sidebar")).toBeVisible();

  await page.setViewportSize(WIDE1280);
  await expect(page.locator(".app")).toHaveAttribute("data-w-tier", "wide");
  await expect(page.locator(".session-rail")).toHaveCount(0);
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveCSS("position", "relative");
});

test("avatar tap jumps to the session; the chat is never covered; the selection ring moves", async ({ page }) => {
  await page.setViewportSize(NARROW360);
  await page.goto(projectUrl("/?session=demo"));
  await expect(page.locator(".app")).toHaveAttribute("data-w-tier", "narrow");
  const rail = page.locator(".session-rail");
  await expect(rail).toBeVisible();

  // demo's root avatar carries the selection ring initially.
  await expect(rail.locator(".rail-avatar[data-session-id='demo']")).toHaveClass(/selected/);
  const chatBefore = await page.locator(".chat").boundingBox();

  // Tap `other` — selection + view jump; the drawer NEVER opens (the rail
  // jumps in place, it does not browse).
  await rail.locator(".rail-avatar[data-session-id='other']").click();
  await expect(page.locator(".main-title")).toHaveText(/Another root/);
  await expect(rail.locator(".rail-avatar[data-session-id='other']")).toHaveClass(/selected/);
  await expect(rail.locator(".rail-avatar[data-session-id='demo']")).not.toHaveClass(/selected/);
  await expect(page.locator(".sidebar")).not.toHaveClass(/open/);

  // Chat visible throughout, geometry unchanged (adjacent, not overlaid).
  const chatAfter = await page.locator(".chat").boundingBox();
  expect(chatAfter).toBeTruthy();
  expect(Math.round(chatAfter!.x)).toBe(Math.round(chatBefore!.x));
  expect(Math.round(chatAfter!.width)).toBe(Math.round(chatBefore!.width));
  const railBox = await rail.boundingBox();
  expect(railBox!.x + railBox!.width).toBeLessThanOrEqual(chatAfter!.x + 1);
});

test("auto-close crux: narrow drawer select closes the drawer; wide select does not hide the sidebar", async ({ page }) => {
  // NARROW: open the drawer (the header toggle), select a session from the
  // tree INSIDE it → the drawer dismisses itself and the chat is revealed.
  await page.setViewportSize(NARROW360);
  await page.goto(projectUrl("/?session=demo"));
  await expect(page.locator(".app")).toHaveAttribute("data-w-tier", "narrow");
  await page.locator(".nav-toggle").click();
  const sb = page.locator(".sidebar");
  await expect(sb).toHaveClass(/open/);
  await expect(sb).toHaveCSS("transform", /matrix\(1, 0, 0, 1, 0, 0\)/); // slid in
  await sb.locator(".tree-node[data-session-id='other']").click();
  // THE CRUX: the drawer dismissed (class gone + back off-canvas), the
  // selected session's chat is showing.
  await expect(sb).not.toHaveClass(/open/);
  await expect(sb).toHaveCSS("transform", /matrix\(1, 0, 0, 1, -[0-9.]+, 0\)/);
  await expect(page.locator(".main-title")).toHaveText(/Another root/);
  await expect(page.locator(".chat")).toBeVisible();

  // The rail's own opener reaches the same drawer (invariant 3) and a select
  // from it closes it again (round-trip).
  await page.locator(".session-rail .rail-open").click();
  await expect(sb).toHaveClass(/open/);
  await sb.locator(".tree-node[data-session-id='demo']").click();
  await expect(sb).not.toHaveClass(/open/);
  await expect(page.locator(".main-title")).toHaveText(/Demo session/);

  // WIDE: no drawer exists; selecting from the inline sidebar leaves it
  // visible (behavior unchanged — the auto-close is narrow-tier only).
  await page.setViewportSize(WIDE1280);
  await expect(page.locator(".app")).toHaveAttribute("data-w-tier", "wide");
  await page.locator(".sidebar .tree-node[data-session-id='other']").click();
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveCSS("position", "relative");
  await expect(page.locator(".main-title")).toHaveText(/Another root/);
});

test("vh.sidebar.w.v1 is never written by the rail (planted value survives all interactions)", async ({ page }) => {
  const PLANTED = JSON.stringify({ v: 1, data: 320 });
  await page.addInitScript((v) => localStorage.setItem("vh.sidebar.w.v1", v), PLANTED);
  await page.setViewportSize(NARROW360);
  await page.goto(projectUrl("/?session=demo"));
  await expect(page.locator(".session-rail")).toBeVisible();

  // Interact: rail jumps, drawer open (rail opener) + select (auto-close),
  // header toggle, tier crossings narrow→rail→narrow.
  const rail = page.locator(".session-rail");
  await rail.locator(".rail-avatar[data-session-id='other']").click();
  await expect(page.locator(".main-title")).toHaveText(/Another root/);
  await rail.locator(".rail-open").click();
  await expect(page.locator(".sidebar")).toHaveClass(/open/);
  await page.locator(".sidebar .tree-node[data-session-id='demo']").click();
  await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
  await page.locator(".nav-toggle").click(); // header toggle reopens…
  await expect(page.locator(".sidebar")).toHaveClass(/open/);
  await page.locator(".sidebar-close").click(); // …and closes
  await page.setViewportSize(RAIL640);
  await expect(page.locator(".app")).toHaveAttribute("data-w-tier", "rail");
  await page.setViewportSize(NARROW360);
  await expect(page.locator(".app")).toHaveAttribute("data-w-tier", "narrow");

  // Byte-identical: the rail never writes the persisted width (no resize
  // handle exists on it — invariant 4).
  expect(await page.evaluate(() => localStorage.getItem("vh.sidebar.w.v1"))).toBe(PLANTED);
});

test("kill-switch off: no rail, and selecting from the drawer does NOT close it (exact legacy)", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("vh.prefs.shapeTier.v1", JSON.stringify({ v: 1, data: "off" })),
  );
  await page.setViewportSize(NARROW360);
  await page.goto(projectUrl("/?session=demo"));
  // The tier signal is inert — no attribute, no rail.
  await expect(page.locator(".app[data-w-tier]")).toHaveCount(0);
  await expect(page.locator(".session-rail")).toHaveCount(0);

  // Legacy drawer behavior: open via the header toggle, select a session —
  // the drawer STAYS open (no auto-close without the tier signal).
  await page.locator(".nav-toggle").click();
  const sb = page.locator(".sidebar");
  await expect(sb).toHaveClass(/open/);
  await sb.locator(".tree-node[data-session-id='other']").click();
  await expect(page.locator(".main-title")).toHaveText(/Another root/);
  await expect(sb).toHaveClass(/open/); // still open — the exact pre-P1 UX
  await page.locator(".sidebar-close").click();
  await expect(sb).not.toHaveClass(/open/);
});

test("mixed states render on the rail (needs ring, unread ring, needs-you badge) + evidence", async ({ page }) => {
  await page.setViewportSize(NARROW360);
  // `demo` selected — the attention probes arm against UNSELECTED sessions.
  await page.goto(projectUrl("/?session=demo"));
  const rail = page.locator(".session-rail");
  await expect(rail).toBeVisible();

  // HERMETIC PROBES: two FRESH sessions created for this test. Never prompt
  // the shared seeded sessions — the fixture's simulated replies carry NO
  // agent stamp, which silently clears a session's tree agent chip and breaks
  // downstream specs (tree2-symptoms (c) relies on `slow` keeping its "build"
  // agent; unread-dot relies on `other`'s clean history). Both probes are
  // answered, acked, and DELETED in the finally block below.
  const oc = { "X-VH-CSRF": "1", "x-opencode-directory": demoDir };
  const mkProbe = async (title: string): Promise<string> => {
    const created = await page.request.post("/oc/session", { headers: oc, data: {} });
    expect(created.ok()).toBeTruthy();
    const id = ((await created.json()) as { id: string }).id;
    const patched = await page.request.patch(`/oc/session/${id}`, { headers: oc, data: { title } });
    expect(patched.ok()).toBeTruthy();
    return id;
  };
  const askProbe = await mkProbe("Ask probe");
  const unreadProbe = await mkProbe("Unread probe");
  // Baseline the needs-you badge BEFORE arming anything (earlier serial-suite
  // specs may legitimately leave attention armed on their own sessions — the
  // assertion is the DELTA, not an absolute count).
  const baseline = await page.evaluate(
    () => Number(document.querySelector(".session-rail .rail-needs")?.getAttribute("data-count") ?? "0"),
  );

  const prompt = (id: string, text: string) =>
    page.evaluate(
      async ({ id, text }) => {
        const res = await fetch(`/oc/session/${id}/prompt_async`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
          body: JSON.stringify({ parts: [{ type: "text", text }] }),
        });
        if (!res.ok && res.status !== 204) throw new Error(`prompt -> ${res.status}`);
      },
      { id, text },
    );

  try {
    // [[ask]] arms a pending question on the unselected ask-probe →
    // needs-input ring; a plain prompt on the unselected unread-probe →
    // busy→idle → the root-scoped unread ring.
    await prompt(askProbe, "hold [[ask]]");
    await prompt(unreadProbe, "session-rail unread probe");

    await expect(
      rail.locator(`.rail-avatar[data-session-id='${askProbe}'][data-ring='needs']`),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      rail.locator(".rail-avatar[data-session-id='" + unreadProbe + "'][data-ring='unread']"),
    ).toBeVisible({ timeout: 15000 });
    // needs-you grew by exactly the two armed roots — each counted once.
    await expect(rail.locator(".rail-needs")).toHaveAttribute("data-count", String(baseline + 2));

    // Evidence (gitignored tmp/) for the operator's visual review + the
    // vision legibility pass.
    await page.screenshot({ path: `${EVIDENCE}/rail-360x800-states.png` });

    // Drawer open OVER the rail (the only covering surface).
    await rail.locator(".rail-open").click();
    const sb = page.locator(".sidebar");
    await expect(sb).toHaveClass(/open/);
    await expect(sb).toHaveCSS("transform", /matrix\(1, 0, 0, 1, 0, 0\)/);
    await page.screenshot({ path: `${EVIDENCE}/rail-360x800-drawer-open.png` });
  } finally {
    // Backend hygiene for the serial suite: answer OUR pending question (its
    // reply continues the turn and may arm the probe's unread), ack both
    // probes, then DELETE both — the shared tree ends exactly as it started.
    await page.evaluate(async (ids) => {
      const list = (await (await fetch("/oc/question")).json()) as {
        id: string;
        sessionID: string;
      }[];
      for (const q of list) {
        if (!ids.includes(q.sessionID)) continue;
        await fetch(`/oc/question/${encodeURIComponent(q.id)}/reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
          body: JSON.stringify({ answers: [["ok"]] }),
        });
      }
      await new Promise((r) => setTimeout(r, 1500)); // let reply turns settle
      for (const id of ids) {
        await fetch("/vh/ack", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
          body: JSON.stringify({ sessionID: id }),
        });
        await fetch(`/oc/fixture/delete?session=${encodeURIComponent(id)}`, {
          method: "POST",
          headers: { "X-VH-CSRF": "1" },
        });
      }
    }, [askProbe, unreadProbe]);
  }
});
