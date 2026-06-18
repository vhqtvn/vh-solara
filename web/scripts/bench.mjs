// Performance benchmark for the chat view with many complex messages.
// Run via scripts/bench.sh (which starts a fixture server seeded with
// VH_BENCH_MESSAGES). Measures load-to-render, DOM size, content-visibility
// effectiveness, scroll jank, and JS heap.
import { chromium } from "@playwright/test";

const base = process.env.BASE || "http://127.0.0.1:8099";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
const page = await ctx.newPage();

await page.goto(base);
await page.waitForTimeout(400);

// Open the bench session and time until the message list is populated.
const t0 = await page.evaluate(() => performance.now());
await page.getByRole("button", { name: /Benchmark/ }).click();
await page.waitForSelector(".msg", { timeout: 30000 });
// Wait until the message count stabilizes (all rows mounted).
let prev = -1,
  stable = 0;
while (stable < 3) {
  const c = await page.locator(".msg").count();
  if (c === prev) stable++;
  else stable = 0;
  prev = c;
  await page.waitForTimeout(120);
}
const t1 = await page.evaluate(() => performance.now());
const msgCount = await page.locator(".msg").count();

// DOM size + how many messages are actually painted (content-visibility skips
// off-screen ones — their contain-intrinsic box has 0 client rects children).
const dom = await page.evaluate(() => {
  const msgs = Array.from(document.querySelectorAll(".msg"));
  let painted = 0;
  for (const m of msgs) {
    const r = m.getBoundingClientRect();
    // A message is "rendered" if it intersects the viewport.
    if (r.bottom > 0 && r.top < window.innerHeight) painted++;
  }
  return { totalNodes: document.querySelectorAll("*").length, msgNodes: msgs.length, paintedInView: painted };
});

// Scroll-jank probe: programmatically scroll the chat to the bottom in steps,
// sampling rAF frame deltas to estimate dropped frames.
const scroll = await page.evaluate(async () => {
  const el = document.querySelector(".chat-scroll");
  if (!el) return null;
  const deltas = [];
  let last = performance.now();
  let frames = 0;
  const target = el.scrollHeight;
  const step = Math.max(1, Math.floor(target / 60));
  return await new Promise((resolve) => {
    function tick() {
      const now = performance.now();
      deltas.push(now - last);
      last = now;
      el.scrollTop = Math.min(el.scrollTop + step, target);
      frames++;
      if (el.scrollTop >= target || frames > 120) {
        deltas.sort((a, b) => a - b);
        const p = (q) => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * q))];
        const dropped = deltas.filter((d) => d > 32).length; // >2 frames @60fps
        resolve({
          frames,
          medianMs: +p(0.5).toFixed(1),
          p95Ms: +p(0.95).toFixed(1),
          maxMs: +Math.max(...deltas).toFixed(1),
          droppedFrames: dropped,
        });
      } else {
        requestAnimationFrame(tick);
      }
    }
    requestAnimationFrame(tick);
  });
});

const heap = await page.evaluate(() => {
  const m = performance.memory;
  return m ? +(m.usedJSHeapSize / 1048576).toFixed(1) : null;
});

console.log(
  JSON.stringify(
    {
      messages: msgCount,
      loadToRenderMs: +(t1 - t0).toFixed(0),
      dom,
      scroll,
      jsHeapMB: heap,
    },
    null,
    2,
  ),
);

await ctx.close();
await browser.close();
