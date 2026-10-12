// Real-browser contract test for the "working indicator stops animating" bug
// class (2026-10-12 follow-up to the self-healing animation gate, ad3856c).
//
// CONTRACT under test (the app's lever, verbatim from production CSS):
//   tokens.css pauses ALL animations while `.pane-hidden` is on <html>:
//     :root.pane-hidden, :root.pane-hidden *, ::before, ::after {
//       animation-play-state: paused !important; }
//   80-professional-pass.css animates the working dots:
//     .working-dots { animation: working-dots-pulse 1.2s ease-in-out infinite; }
//
// Finding this spec pins: the play-state mechanics are SOUND in every probed
// engine (chromium/firefox/webkit) — an animation CREATED under the pause
// rule (Working pill mounted while the pane is hidden) resumes on reveal,
// and so does one paused mid-flight, inside a visibility:hidden iframe (the
// host-hidden pane posture) too. The freeze bug class is therefore NOT
// browser play-state semantics — it is the CLASS getting stuck ON (the
// lost-visibilitychange posture paneVisibility.ts self-heals) or a
// compositor-level failure no headless lane can observe. These tests guard
// the first boundary: if a browser regression or a CSS change (e.g. someone
// switching the pause to `animation: none`) breaks created-while-paused or
// paused-mid-flight resume, this goes red at the animation-clock level.
//
// Observation discipline (learned from probe v1): headless Chromium only
// produces frames on mutation, so wall-clock waits alone leave the animation
// clock unreadable there — every wait is rAF-pumped and every arm carries a
// control that proves the clock is observable in that engine before the
// posture under test is judged. A finished CSS animation is REMOVED from
// getAnimations() (css-animations-2 reaping), so for one-shots "reaped"
// means "completed", not "missing".
//
// Self-contained: page.setContent only — no fixture backend, no app build.

import { expect, test } from "@playwright/test";

const STYLE = `
  :root.pane-hidden, :root.pane-hidden *, :root.pane-hidden *::before, :root.pane-hidden *::after {
    animation-play-state: paused !important;
  }
  .working-dots {
    display: inline-block; width: 18px;
    animation: working-dots-pulse 1.2s ease-in-out infinite;
  }
  .working-dots::after { content: "..."; }
  @keyframes working-dots-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  /* One-shot mount cue (the .vh-current trace) — same created-while-paused
   * exposure inside the Working pill. */
  .vh-current-like { animation: one-shot 0.3s linear 1; }
  @keyframes one-shot { from { opacity: 0; } to { opacity: 1; } }
`;

const FRAME_SRC = `<!doctype html><html><head><style>${STYLE}</style></head><body></body></html>`;

type AnimSample = { cls: string; playState: string; currentTime: number | null };

/** Pump the frame loop: resolve after N animation frames. If rAF does not
 *  fire in this engine/posture, this hangs and the test times out — which is
 *  itself the "clock not observable here" signal. */
async function frames(page: import("@playwright/test").Page, n: number): Promise<void> {
  await page.evaluate((count) => {
    return new Promise<void>((resolve) => {
      const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
      step(count);
    });
  }, n);
}

/** Sample the animation clock of every animated probe element. */
async function sample(page: import("@playwright/test").Page): Promise<AnimSample[]> {
  return page.evaluate(() => {
    const out: { cls: string; playState: string; currentTime: number | null }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(".working-dots, .vh-current-like"))) {
      for (const a of el.getAnimations()) {
        out.push({
          cls: el.className,
          playState: a.playState,
          currentTime: a.currentTime === null ? null : Number(a.currentTime),
        });
      }
    }
    return out;
  });
}

/** Mount probe elements (created AFTER the current pause state — this is the
 *  created-while-paused vs created-running lever). */
async function mount(page: import("@playwright/test").Page, cls: "working-dots" | "vh-current-like"): Promise<void> {
  await page.evaluate((c) => {
    const el = document.createElement("span");
    el.className = c;
    el.textContent = "...";
    document.body.appendChild(el);
  }, cls);
}

test.beforeEach(async ({ page }) => {
  await page.setContent(`<!doctype html><html><head><style>${STYLE}</style></head><body></body></html>`);
});

test("control: infinite animation created while NOT paused ticks (harness sanity)", async ({ page }) => {
  await mount(page, "working-dots");
  await frames(page, 5);
  const s1 = await sample(page);
  await frames(page, 20);
  const s2 = await sample(page);
  test.info().annotations.push({ type: "probe", description: `control: ${JSON.stringify({ s1, s2 })}` });
  expect(s1.length, "one CSS animation on the dots").toBe(1);
  expect(s1[0].playState).toBe("running");
  expect(s2[0].currentTime!, "clock advances on a never-paused animation").toBeGreaterThan(s1[0].currentTime!);
});

test("bug posture: infinite animation CREATED while paused resumes on reveal", async ({ page }) => {
  // The real sequence: turn starts while the tab/host pane is hidden → the
  // pill (and its animation) is CREATED under the pause rule; later the pane
  // is revealed (class lifted — what installPaneAnimationGate guarantees).
  await page.evaluate(() => document.documentElement.classList.add("pane-hidden"));
  await mount(page, "working-dots");
  const paused = await sample(page);
  expect(paused.length).toBe(1);
  expect(paused[0].playState, "created under the pause rule").toBe("paused");

  // Reveal.
  await page.evaluate(() => document.documentElement.classList.remove("pane-hidden"));
  await frames(page, 5);
  const s1 = await sample(page);
  await frames(page, 20);
  const s2 = await sample(page);
  test.info().annotations.push({
    type: "probe",
    description: `created-while-paused samples: ${JSON.stringify({ paused, s1, s2 })}`,
  });
  expect(s1.length).toBe(1);
  expect(s1[0].playState, "unpaused play-state").toBe("running");
  expect(s2[0].currentTime!, "clock advances after reveal (the reported bug: dots frozen)").toBeGreaterThan(
    s1[0].currentTime!,
  );
});

test("one-shot mount cue created while paused completes after reveal", async ({ page }) => {
  await page.evaluate(() => document.documentElement.classList.add("pane-hidden"));
  await mount(page, "vh-current-like");
  await page.evaluate(() => document.documentElement.classList.remove("pane-hidden"));
  await frames(page, 40); // ~0.66s at 60fps, >> 0.3s duration
  const s = await sample(page);
  test.info().annotations.push({ type: "probe", description: `one-shot after reveal: ${JSON.stringify(s)}` });
  // Finished CSS animations are reaped from getAnimations(): "gone" = done.
  // If still present, its clock must be past the 300ms duration. Still
  // present AND frozen at ~0 is the bug shape.
  if (s.length > 0) {
    expect(s[0].currentTime!, "one-shot advanced past its duration after reveal").toBeGreaterThanOrEqual(300);
  }
});

test("embedded posture: animation created in a visibility:hidden iframe resumes on reveal", async ({ page }) => {
  // Faithful to the host shell: hidden panes are iframes the host styles
  // with `visibility: hidden` (cross-origin-blindness is paneVisibility.ts's
  // whole reason for existing — here srcdoc keeps it same-origin so the test
  // can reach in). Turn starts while host-hidden → class ON inside the pane
  // AND the iframe itself visibility:hidden → host reveals both.
  await page.evaluate((src) => {
    const iframe = document.createElement("iframe");
    iframe.srcdoc = src;
    iframe.style.visibility = "hidden";
    iframe.style.width = "200px";
    iframe.style.height = "50px";
    document.body.appendChild(iframe);
  }, FRAME_SRC);
  await page.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.readyState === "complete");

  const pane = (): Promise<{ cls: string; playState: string; currentTime: number | null }[]> =>
    page.evaluate(() => {
      const doc = document.querySelector("iframe")!.contentDocument!;
      const out: { cls: string; playState: string; currentTime: number | null }[] = [];
      for (const el of Array.from(doc.querySelectorAll<HTMLElement>(".working-dots"))) {
        for (const a of el.getAnimations()) {
          out.push({
            cls: el.className,
            playState: a.playState,
            currentTime: a.currentTime === null ? null : Number(a.currentTime),
          });
        }
      }
      return out;
    });
  const paneFrames = (n: number): Promise<void> =>
    page.evaluate((count) => {
      const doc = document.querySelector("iframe")!.contentDocument!;
      const raf = (doc.defaultView ?? window).requestAnimationFrame.bind(doc.defaultView ?? window);
      return new Promise<void>((resolve) => {
        const step = (left: number) => (left <= 0 ? resolve() : raf(() => step(left - 1)));
        step(count);
      });
    }, n);

  // Hidden pane: class ON inside the pane, iframe visibility:hidden outside.
  await page.evaluate(() => {
    const doc = document.querySelector("iframe")!.contentDocument!;
    doc.documentElement.classList.add("pane-hidden");
    const el = doc.createElement("span");
    el.className = "working-dots";
    el.textContent = "...";
    doc.body.appendChild(el);
  });
  // Reveal BOTH layers (host unhides the pane; the gate lifts the class).
  await page.evaluate(() => {
    const iframe = document.querySelector("iframe")!;
    iframe.style.visibility = "";
    iframe.contentDocument!.documentElement.classList.remove("pane-hidden");
  });
  await paneFrames(5);
  const s1 = await pane();
  await paneFrames(20);
  const s2 = await pane();
  test.info().annotations.push({ type: "probe", description: `embedded posture: ${JSON.stringify({ s1, s2 })}` });
  expect(s1.length).toBe(1);
  expect(s1[0].playState, "unpaused play-state inside the revealed iframe").toBe("running");
  expect(s2[0].currentTime!, "clock advances after the host reveals the pane").toBeGreaterThan(s1[0].currentTime!);
});

// ---- real document visibility (backgrounding via a second page) ------------
//
// The class-toggle arms above prove style-level resume; these arms drive the
// REAL visibility machinery: opening another page in the same context
// backgrounds this one (real document.hidden, real throttling), exactly like
// the operator switching tabs. The gate's real sequence is mirrored by hand:
// hide → class ON; reveal → class OFF (paneVisibility is unit-proven; the
// open question is browser semantics around real visibility transitions).
// Headless keeps every page "visible", so these SELF-SKIP there — they arm
// automatically wherever backgrounding is real (e.g. a future headed lane).

test("REAL visibility: running animation paused by a real background tab resumes on return", async ({
  page,
  context,
}) => {
  await mount(page, "working-dots");
  await frames(page, 5);
  const before = await sample(page);
  expect(before[0]?.currentTime!, "sanity: clock observable before hiding").toBeGreaterThan(0);

  const bg = await context.newPage(); // backgrounds `page` for real
  try {
    await page
      .waitForFunction(() => document.visibilityState === "hidden", null, { timeout: 3_000 })
      .catch(() => {});
    const hidden = await page.evaluate(() => document.visibilityState === "hidden");
    test.skip(
      !hidden,
      "this environment never backgrounds pages (headless keeps every page visible) — real visibilitychange is not producible here",
    );
    await page.evaluate(() => document.documentElement.classList.add("pane-hidden")); // the gate's hide edge
    await page.waitForTimeout(3_000); // stay hidden a while (real throttled time passage)
    await page.bringToFront();
    await page.waitForFunction(() => document.visibilityState === "visible", null, { timeout: 5_000 });
    await page.evaluate(() => document.documentElement.classList.remove("pane-hidden")); // the gate's reveal edge
  } finally {
    await bg.close();
  }
  await frames(page, 5);
  const s1 = await sample(page);
  await frames(page, 20);
  const s2 = await sample(page);
  test.info().annotations.push({ type: "probe", description: `real-visibility paused-mid-flight: ${JSON.stringify({ before, s1, s2 })}` });
  expect(s1.length).toBe(1);
  expect(s1[0].playState, "running after a real hide/reveal cycle").toBe("running");
  expect(s2[0].currentTime!, "clock advances after a real hide/reveal cycle").toBeGreaterThan(s1[0].currentTime!);
});

test("REAL visibility: animation CREATED in a hidden tab resumes on return", async ({ page, context }) => {
  const bg = await context.newPage(); // backgrounds `page` for real
  try {
    await page
      .waitForFunction(() => document.visibilityState === "hidden", null, { timeout: 3_000 })
      .catch(() => {});
    const hidden = await page.evaluate(() => document.visibilityState === "hidden");
    test.skip(
      !hidden,
      "this environment never backgrounds pages (headless keeps every page visible) — real visibilitychange is not producible here",
    );
    await page.evaluate(() => document.documentElement.classList.add("pane-hidden")); // the gate's hide edge
    await mount(page, "working-dots"); // the turn starts while the tab is hidden
    await page.waitForTimeout(3_000);
    await page.bringToFront();
    await page.waitForFunction(() => document.visibilityState === "visible", null, { timeout: 5_000 });
    await page.evaluate(() => document.documentElement.classList.remove("pane-hidden")); // the gate's reveal edge
  } finally {
    await bg.close();
  }
  await frames(page, 5);
  const s1 = await sample(page);
  await frames(page, 20);
  const s2 = await sample(page);
  test.info().annotations.push({ type: "probe", description: `real-visibility created-hidden: ${JSON.stringify({ s1, s2 })}` });
  expect(s1.length).toBe(1);
  expect(s1[0].playState, "running after creation in a hidden tab").toBe("running");
  expect(s2[0].currentTime!, "clock advances after creation in a hidden tab").toBeGreaterThan(s1[0].currentTime!);
});
