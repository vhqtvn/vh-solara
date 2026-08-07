import { expect, type Page } from "@playwright/test";

// Bridge wrappers. window.__host is installed by HostController in the BROWSER.
// Each page.evaluate runs in the browser context, so it MUST inline the
// __host lookup — it cannot close over any Node-side helper (closures are not
// transferred across the Playwright boundary). Return values are serialized.

export interface Survival {
  mountTs: number;
  nonce: string;
  uptime: number;
  connId: number | null;
  src: string;
  lastSeen: number;
}
export interface Baseline {
  mountTs: number;
  nonce: string;
  connId: number | null;
}

export async function panes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const h = (window as unknown as { __host?: { panes(): string[] } }).__host;
    return h ? h.panes() : [];
  });
}
export async function focused(page: Page): Promise<string | null> {
  const r = await page.evaluate(() => {
    const h = (window as unknown as { __host?: { focused(): string | null } }).__host;
    return h ? h.focused() : null;
  });
  return r ?? null;
}
export async function trayIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const h = (window as unknown as { __host?: { trayIds(): string[] } }).__host;
    return h ? h.trayIds() : [];
  });
}
export async function gridPaneCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const h = (window as unknown as { __host?: { gridPaneCount(): number } }).__host;
    return h ? h.gridPaneCount() : 0;
  });
}
export async function isMaximized(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const h = (window as unknown as { __host?: { isMaximized(): boolean } }).__host;
    return h ? h.isMaximized() : false;
  });
}
export async function connected(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const h = (window as unknown as { __host?: { connected(): boolean } }).__host;
    return h ? h.connected() : false;
  });
}

export async function survival(page: Page, id: string): Promise<Survival | null> {
  return page.evaluate((id) => {
    const h = (window as unknown as { __host?: { survival(i: string): Survival | null } }).__host;
    return h ? h.survival(id) : null;
  }, id);
}
export async function baseline(page: Page, id: string): Promise<Baseline | null> {
  return page.evaluate((id) => {
    const h = (window as unknown as { __host?: { baseline(i: string): Baseline | null } }).__host;
    return h ? h.baseline(id) : null;
  }, id);
}
export async function resetBaseline(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => {
    const h = (window as unknown as { __host?: { resetBaseline(i: string): void } }).__host;
    h?.resetBaseline(id);
  }, id);
}
export async function groupBox(
  page: Page,
  id: string,
): Promise<{ left: number; top: number; width: number; height: number } | null> {
  return page.evaluate((id) => {
    const h = (window as unknown as { __host?: { groupBox(i: string): { left: number; top: number; width: number; height: number } | null } }).__host;
    return h ? h.groupBox(id) : null;
  }, id);
}

export async function split(page: Page, id: string, dir: "right" | "down"): Promise<string | null> {
  const r = await page.evaluate(({ id, dir }) => {
    const h = (window as unknown as { __host?: { split(i: string, d: "right" | "down"): string | null } }).__host;
    return h ? h.split(id, dir) : null;
  }, { id, dir });
  return r ?? null;
}
export async function swap(page: Page, a: string, b: string): Promise<void> {
  await page.evaluate(({ a, b }) => {
    const h = (window as unknown as { __host?: { swap(x: string, y: string): void } }).__host;
    h?.swap(a, b);
  }, { a, b });
}
export async function closePane(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => {
    const h = (window as unknown as { __host?: { closePane(i: string): void } }).__host;
    h?.closePane(id);
  }, id);
}
export async function focusPane(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => {
    const h = (window as unknown as { __host?: { focus(i: string): void } }).__host;
    h?.focus(id);
  }, id);
}
export async function maximize(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => {
    const h = (window as unknown as { __host?: { maximize(i: string): void } }).__host;
    h?.maximize(id);
  }, id);
}
export async function exitMaximized(page: Page): Promise<void> {
  await page.evaluate(() => {
    const h = (window as unknown as { __host?: { exitMaximized(): void } }).__host;
    h?.exitMaximized();
  });
}
export async function collapse(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => {
    const h = (window as unknown as { __host?: { collapse(i: string): void } }).__host;
    h?.collapse(id);
  }, id);
}
export async function restore(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => {
    const h = (window as unknown as { __host?: { restore(i: string): void } }).__host;
    h?.restore(id);
  }, id);
}
export async function naiveReload(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => {
    const h = (window as unknown as { __host?: { naiveReload(i: string): void } }).__host;
    h?.naiveReload(id);
  }, id);
}
export async function jsonReswap(page: Page): Promise<void> {
  await page.evaluate(() => {
    const h = (window as unknown as { __host?: { jsonReswap(): void } }).__host;
    h?.jsonReswap();
  });
}

// ---- waiting helpers -------------------------------------------------------

/** Wait until the pane has heartbeated AND its WS echo connection is up. */
export async function waitForReady(page: Page, id: string, timeoutMs = 15000): Promise<Survival> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await survival(page, id);
    if (s && s.connId != null && s.mountTs > 0) return s;
    await page.waitForTimeout(100);
  }
  throw new Error(`pane ${id} never heartbeated (connId) within ${timeoutMs}ms`);
}

/** Wait until a heartbeat arrives AFTER the given lastSeen timestamp. */
export async function waitForFreshHeartbeat(
  page: Page,
  id: string,
  afterSeen: number,
  timeoutMs = 8000,
): Promise<Survival> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await survival(page, id);
    if (s && s.lastSeen > afterSeen) return s;
    await page.waitForTimeout(80);
  }
  throw new Error(`pane ${id} never produced a fresh heartbeat after ${afterSeen} within ${timeoutMs}ms`);
}

// ---- assertions -----------------------------------------------------------

/** The pane identity SURVIVED: mountTs/nonce/connId unchanged, uptime climbing. */
export async function assertSurvived(page: Page, id: string, before: Survival, label: string): Promise<void> {
  const after = await waitForFreshHeartbeat(page, id, before.lastSeen);
  expect(after.mountTs, `${label}: mountTs unchanged (iframe not reloaded)`).toBe(before.mountTs);
  expect(after.nonce, `${label}: nonce unchanged (iframe not reloaded)`).toBe(before.nonce);
  expect(after.connId, `${label}: connId unchanged (WS not reconnected)`).toBe(before.connId);
  expect(after.uptime, `${label}: uptime climbing`).toBeGreaterThanOrEqual(before.uptime);
}

/** The pane RELOADED: identity changed (mountTs/nonce/connId differ). */
export async function assertReloaded(page: Page, id: string, before: Survival, label: string): Promise<void> {
  const after = await waitForFreshHeartbeat(page, id, before.lastSeen, 10000);
  const reloaded =
    after.mountTs !== before.mountTs ||
    after.nonce !== before.nonce ||
    after.connId !== before.connId;
  expect(reloaded, `${label}: iframe RELOADED (identity changed)`).toBe(true);
}

/** Load the host SPA and wait for the initial panes to be live. */
export async function loadHost(page: Page): Promise<string[]> {
  await page.goto("/");
  await expect.poll(async () => connected(page), { timeout: 20000 }).toBe(true);
  const ids = await panes(page);
  expect(ids.length, "seeded panes present").toBeGreaterThanOrEqual(2);
  for (const id of ids) await waitForReady(page, id);
  return ids;
}
