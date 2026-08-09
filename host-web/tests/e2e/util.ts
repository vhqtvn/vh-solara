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

// ---- multi-workspace bridge helpers (window.__host, DEV-only) --------------
// The workspace model: N workspaces, each its own Dockview tree. Switching is
// CSS-visibility-only (survival-safe — no iframe reloads). These drive the
// model programmatically for the workspace-switch survival gate + shell tests.

export async function workspaces(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const h = (window as unknown as { __host?: { workspaces(): string[] } }).__host;
    return h ? h.workspaces() : [];
  });
}

export async function activeWorkspace(page: Page): Promise<string | null> {
  const r = await page.evaluate(() => {
    const h = (window as unknown as { __host?: { activeWorkspace(): string | null } }).__host;
    return h ? h.activeWorkspace() : null;
  });
  return r ?? null;
}

export async function setActiveWorkspace(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => {
    const h = (window as unknown as { __host?: { setActiveWorkspace(i: string): void } }).__host;
    h?.setActiveWorkspace(id);
  }, id);
}

export async function addWorkspace(page: Page, name?: string): Promise<string | null> {
  const r = await page.evaluate((name) => {
    const h = (window as unknown as { __host?: { addWorkspace(n?: string): string } }).__host;
    return h ? h.addWorkspace(name) : null;
  }, name);
  return r ?? null;
}

export async function closeWorkspace(page: Page, id: string): Promise<boolean> {
  return page.evaluate((id) => {
    const h = (window as unknown as { __host?: { closeWorkspace(i: string): boolean } }).__host;
    return h ? h.closeWorkspace(id) : false;
  }, id);
}

// Read-only {url,label,route} snapshot per panel — used by the layout-persistence
// e2e to assert a restored layout round-trips with the correct urls/labels, and
// by the route-survival e2e to assert a captured route persists across reload.
export interface PaneParam {
  id: string;
  url: string;
  label: string;
  route?: string;
}
export async function paneParams(page: Page): Promise<PaneParam[]> {
  return page.evaluate(() => {
    const h = (window as unknown as { __host?: { paneParams(): PaneParam[] } }).__host;
    return h ? h.paneParams() : [];
  });
}

// Read-only full-layout serialization (api.toJSON). The persistence negative
// control captures a real layout via this, poisons one url, and writes it back.
export async function serialize(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const h = (window as unknown as { __host?: { serialize(): unknown } }).__host;
    return (h ? h.serialize() : {}) as Record<string, unknown>;
  });
}

// ---- document-liveness protocol probes (heartbeat-protocol e2e) ------------
// These drive the DEV-only window.__host bridge (absent in prod builds). The
// scratch-pane surface is a self-contained mini-pane with NO real heartbeat
// stream, so protocol-logic assertions are deterministic (no interleaving).

export type LivenessState = "alive" | "reloaded" | "no-signal";

export type RouteReason =
  | "ignored-non-pane-to-host"
  | "rejected:unknown-source"
  | "rejected:origin-mismatch"
  | "rejected:stale-nonce"
  | "accepted:first-after-load"
  | "accepted:reload"
  | "accepted:stable"
  | "accepted:non-heartbeat";

export interface RouteResult {
  routed: boolean;
  paneId: string | null;
  accepted: boolean;
  reason: RouteReason;
}

/** Liveness state of a real pane (drives the Q1-C indicator). */
export async function liveness(page: Page, id: string): Promise<LivenessState> {
  return page.evaluate((id) => {
    const h = (window as unknown as { __host?: { liveness(i: string): LivenessState } }).__host;
    return h ? h.liveness(id) : "no-signal";
  }, id);
}

/** Create a scratch protocol pane (sentinel source + origin + pending load).
 *  The sentinel lives in-page; address it via the scratchId in protocolProbe. */
export async function protocolScratch(
  page: Page,
  id: string,
  origin: string,
): Promise<void> {
  await page.evaluate(({ id, origin }) => {
    const h = (window as unknown as { __host?: { protocolScratch(i: string, o: string): void } }).__host;
    h?.protocolScratch(id, origin);
  }, { id, origin });
}

/** Route a synthetic message through the REAL router. `scratchId` resolves to
 *  the scratch pane's in-page sentinel source; pass null for an unknown source
 *  (wrong-window rejection). Returns the verdict. */
export async function protocolProbe(
  page: Page,
  args: { scratchId: string | null; origin: string; payload: unknown },
): Promise<RouteResult> {
  return page.evaluate(({ scratchId, origin, payload }) => {
    const h = (window as unknown as { __host?: { protocolProbe(a: { scratchId: string | null; origin: string; payload: unknown }): RouteResult } }).__host;
    return h
      ? h.protocolProbe({ scratchId, origin, payload })
      : { routed: false, paneId: null, accepted: false, reason: "ignored-non-pane-to-host" as RouteReason };
  }, args);
}

/** Liveness state of a scratch protocol pane. */
export async function protocolLiveness(page: Page, id: string): Promise<LivenessState> {
  return page.evaluate((id) => {
    const h = (window as unknown as { __host?: { protocolLiveness(i: string): LivenessState } }).__host;
    return h ? h.protocolLiveness(id) : "no-signal";
  }, id);
}

/** Mark a pending load on a scratch/real pane (forces re-establish identity). */
export async function protocolNoteLoad(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => {
    const h = (window as unknown as { __host?: { protocolNoteLoad(i: string): void } }).__host;
    h?.protocolNoteLoad(id);
  }, id);
}

/** Issue a handshake for a scratch/real pane (stores the issued challenge nonce
 *  the host will verify the first post-load heartbeat against). */
export async function protocolHandshake(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => {
    const h = (window as unknown as { __host?: { sendHandshake(i: string): void } }).__host;
    h?.sendHandshake(id);
  }, id);
}

/** Read the challenge nonce the host issued for a pane's current pending load. */
export async function expectedNonce(page: Page, id: string): Promise<string | null> {
  return page.evaluate((id) => {
    const h = (window as unknown as { __host?: { expectedNonce(i: string): string | null } }).__host;
    return h ? h.expectedNonce(id) : null;
  }, id);
}

/** Dispose a scratch protocol pane (clears its protocol state). */
export async function protocolDispose(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => {
    const h = (window as unknown as { __host?: { protocolDispose(i: string): void } }).__host;
    h?.protocolDispose(id);
  }, id);
}

// ---- route-emission probe (route-message capture) --------------------------
// Synthesize a pane→host message through the REAL routeMessage router with a
// real pane's contentWindow as source. Used to drive a route change into a pane
// exactly as the real SPA's heartbeat-loop emission would (the route variant
// {type:"route",route} is source-bound like title, so any origin passes).

/** Route a synthetic message through the real router using a real pane's
 *  contentWindow as the source. Returns the router verdict. */
export async function probePaneMessage(
  page: Page,
  args: { sourcePaneId: string; origin: string; payload: unknown },
): Promise<RouteResult> {
  return page.evaluate(({ sourcePaneId, origin, payload }) => {
    const h = (window as unknown as { __host?: { probeHeartbeat(a: { sourcePaneId: string | null; origin: string; payload: unknown }): RouteResult } }).__host;
    return h
      ? h.probeHeartbeat({ sourcePaneId, origin, payload })
      : { routed: false, paneId: null, accepted: false, reason: "ignored-non-pane-to-host" as RouteReason };
  }, args);
}

// ---- P1 session-attention probes -------------------------------------------
// Drive a {type:"status"} message through the REAL routeMessage router (source-
// bound to a real pane's contentWindow — same path the SPA's statusEmitter
// uses) and read back the per-pane status + the active-workspace needs-you
// aggregate. The bridge is DEV-only; these run under the dev:host webServer.

export interface PaneStatus {
  dir: string;
  session: string;
  title: string;
  attention: "none" | "needs_reply" | "needs_permission";
  activity: "running" | "idle" | "done_unread" | "error" | "unknown";
}

/** Post a {type:"status"} message from a pane (source-bound) through the real
 *  router, exactly as the SPA's statusEmitter would. Returns the verdict. */
export async function probeStatus(
  page: Page,
  args: { sourcePaneId: string; origin: string; payload: unknown },
): Promise<RouteResult> {
  return probePaneMessage(page, args);
}

/** Last-reported P1 status for a pane (source-bound; null until the first
 *  status lands). */
export async function status(page: Page, id: string): Promise<PaneStatus | null> {
  return page.evaluate((id) => {
    const h = (window as unknown as { __host?: { status(i: string): PaneStatus | null } }).__host;
    return h ? h.status(id) : null;
  }, id);
}

/** Active-workspace needs-you aggregate (panes whose attention is
 *  needs_permission or needs_reply). Drives the workspace badge. */
export async function needsYou(page: Page): Promise<number> {
  return page.evaluate(() => {
    const h = (window as unknown as { __host?: { needsYou(): number } }).__host;
    return h ? h.needsYou() : 0;
  });
}

// ---- P3 NEXT hero button probes --------------------------------------------
// Inspect the ranking without acting (nextTarget), trigger the action (next),
// and read the host-latched firstNeedsYouAt tiebreak. next/nextTarget route
// through attentionNext.ts (the SAME production path the statusbar button uses).

export interface NeedyCandidate {
  paneId: string;
  wsId: string;
  attention: string;
  firstNeedsYouAt: number;
}

/** The highest-priority needy pane system-wide (null when none). Read-only. */
export async function nextTarget(page: Page): Promise<NeedyCandidate | null> {
  return page.evaluate(() => {
    const h = (window as unknown as { __host?: { nextTarget(): NeedyCandidate | null } }).__host;
    return h ? h.nextTarget() : null;
  });
}

/** Trigger the NEXT hero button action (rank → cross-ws → restore-from-tray →
 *  keyboard-rule → focus) through the production attentionNext path. */
export async function next(page: Page): Promise<void> {
  await page.evaluate(() => {
    const h = (window as unknown as { __host?: { next(): void } }).__host;
    h?.next();
  });
}

/** The host-latched timestamp when the pane transitioned into its current
 *  needs-you state (null when not currently needs-you / never latched). */
export async function firstNeedsYouAt(page: Page, id: string): Promise<number | null> {
  return page.evaluate((id) => {
    const h = (window as unknown as { __host?: { firstNeedsYouAt(i: string): number | null } }).__host;
    return h ? h.firstNeedsYouAt(id) : null;
  }, id);
}

// ---- URL hash state (per-tab URL source-of-truth) --------------------------

/** The raw location.hash string ("" when none). */
export async function rawHash(page: Page): Promise<string> {
  return page.evaluate(() => window.location.hash);
}

/** Decode the `#state=<encoded>` URL hash into the PersistedState JSON object,
 *  or null when there is no hash / it is malformed. */
export async function readHashState(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const hash = window.location.hash;
    if (!hash || !hash.startsWith("#state=")) return null;
    try {
      return JSON.parse(decodeURIComponent(hash.slice("#state=".length)));
    } catch {
      return null;
    }
  });
}

/** Wait until location.hash starts with `#state=` (the debounced save has
 *  written it). Throws after timeoutMs. */
export async function waitForHashState(page: Page, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const has = await page.evaluate(() => window.location.hash.startsWith("#state="));
    if (has) return;
    await page.waitForTimeout(80);
  }
  throw new Error(`location.hash never acquired a #state= within ${timeoutMs}ms`);
}

/** Wait until the decoded #state= hash contains `substring` (the debounced save
 *  has flushed the NEW content). Use this (not waitForHashState) when the hash
 *  already exists from a prior save and you need to wait for an UPDATE. */
export async function waitForHashContent(page: Page, substring: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const json = await readHashState(page);
    if (json !== null && JSON.stringify(json).includes(substring)) return;
    await page.waitForTimeout(80);
  }
  throw new Error(`location.hash never contained "${substring}" within ${timeoutMs}ms`);
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
// Add a server to the runtime catalog + open a pane for it in the ACTIVE
// workspace (returns the new pane id, or null when isFleetEntry rejects).
export async function addServer(page: Page, url: string, label: string): Promise<string | null> {
  const r = await page.evaluate(({ url, label }) => {
    const h = (window as unknown as { __host?: { addServer(u: string, l: string): string | null } }).__host;
    return h ? h.addServer(url, label) : null;
  }, { url, label });
  return r ?? null;
}
// Remove a server (by url) from the runtime catalog + close its panes in the
// ACTIVE workspace. Returns true when applied; false when refused.
export async function removeServer(page: Page, url: string): Promise<boolean> {
  return page.evaluate((url) => {
    const h = (window as unknown as { __host?: { removeServer(u: string): boolean } }).__host;
    return h ? h.removeServer(url) : false;
  }, url);
}
// P4 reverse-nav: drive a select through the production HostOps path
// (hostOps().selectTarget). Posts {type:'vh-host-select',dir,session} to the
// pane's contentWindow; the mock stand-in re-emits {type:'route',route} as the
// round-trip signal (the real SPA's heartbeat loop does the same after its
// SPA-internal setSelectedId/switchProject).
export async function selectTarget(
  page: Page,
  paneId: string,
  dir: string,
  session: string,
): Promise<void> {
  await page.evaluate(({ paneId, dir, session }) => {
    const h = (window as unknown as { __host?: { selectTarget(p: string, d: string, s: string): void } }).__host;
    h?.selectTarget(paneId, dir, session);
  }, { paneId, dir, session });
}
// DEV-only test arrangement: dock `a` into `b`'s group as a tab. No shell op
// creates a tabbed group, so this is the only deterministic way to reach
// swap()'s same-group branch in e2e. Uses the survival-safe moveTo primitive.
export async function dockAsTab(page: Page, a: string, b: string): Promise<void> {
  await page.evaluate(({ a, b }) => {
    const h = (window as unknown as { __host?: { dockAsTab(x: string, y: string): void } }).__host;
    h?.dockAsTab(a, b);
  }, { a, b });
}
// Read-only: are `a` and `b` currently in the same Dockview group?
export async function sameGroup(page: Page, a: string, b: string): Promise<boolean> {
  return page.evaluate(({ a, b }) => {
    const h = (window as unknown as { __host?: { sameGroup(x: string, y: string): boolean } }).__host;
    return h ? h.sameGroup(a, b) : false;
  }, { a, b });
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

// ---- keyboard focus-mode bridge (window.__hostKbdFocus, DEV-only) ----------
// Drives the host-owned keyboard focus-mode (host-web/src/keyboardFocus.ts)
// programmatically for deterministic headless e2e. The real soft-keyboard
// OUTCOME is not-demonstrable headlessly; these hooks prove the MECHANISM.

export interface KbdFocusState {
  open: boolean;
  ownedWs: string | null;
}

/** Read the focus-mode state (open + owned workspace). */
export async function kbdFocusState(page: Page): Promise<KbdFocusState> {
  return page.evaluate(() => {
    const b = (window as unknown as { __hostKbdFocus?: { isOpen(): boolean; ownedWs(): string | null } }).__hostKbdFocus;
    return {
      open: b ? b.isOpen() : false,
      ownedWs: b ? b.ownedWs() : null,
    };
  });
}

/** Simulate keyboard-open at a given visible height (px). Bypasses the gate +
 *  heuristic so the mechanism is provable headlessly. Idempotent. */
export async function kbdFocusOpen(page: Page, visibleHeight: number): Promise<void> {
  await page.evaluate((h) => {
    const b = (window as unknown as { __hostKbdFocus?: { open(h: number): void } }).__hostKbdFocus;
    b?.open(h);
  }, visibleHeight);
}

/** Simulate keyboard-close. Restores the root + exits the owned maximize. */
export async function kbdFocusClose(page: Page): Promise<void> {
  await page.evaluate(() => {
    const b = (window as unknown as { __hostKbdFocus?: { close(): void } }).__hostKbdFocus;
    b?.close();
  });
}

/** Force the REAL detection path (heuristic + debounce) to run now. Used by the
 *  e2e to prove the listener fires open/close after a visualViewport change. */
export async function kbdFocusFlushDetection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const b = (window as unknown as { __hostKbdFocus?: { flushDetection(): void } }).__hostKbdFocus;
    b?.flushDetection();
  });
}

/** The focused pane's iframe element bounding box (null when none). */
export async function focusedIframeBox(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page.evaluate(async () => {
    const h = (window as unknown as {
      __host?: { focused(): string | null; getIframe(i: string): HTMLIFrameElement | null };
    }).__host;
    if (!h) return null;
    const id = h.focused();
    if (!id) return null;
    const f = h.getIframe(id);
    if (!f) return null;
    const r = f.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

/** The host root (`.app`) client height — what keyboard focus-mode overrides. */
export async function appRootHeight(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="host-app-root"]') as HTMLElement | null;
    return el ? el.clientHeight : 0;
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

// ---- layout-persistence helpers -------------------------------------------

/** Storage key persistence writes (must match src/dockview/layoutPersistence.ts). */
export const LAYOUT_STORAGE_KEY = "vh-host:layout:v2";

/** Wait until localStorage holds a saved layout with the expected TOTAL panel
 *  count across all workspaces. The v2 schema wraps each workspace's serialized
 *  layout under `workspaces[*].layout`; this sums panels across every workspace
 *  so a multi-workspace save is validated. The save is debounced (~450ms); this
 *  polls the raw blob so a test can flush it before reloading. Returns a map of
 *  paneId → params aggregated across all workspaces. */
export async function waitForSavedLayout(
  page: Page,
  expectedTotalPanelCount: number,
  timeoutMs = 8000,
): Promise<Record<string, { params?: { url?: string; label?: string } }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const aggregated = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as {
          workspaces?: Array<{ layout?: { panels?: Record<string, unknown> } }>;
        };
        const wsList = parsed.workspaces ?? [];
        const panels: Record<string, unknown> = {};
        for (const ws of wsList) {
          const lp = ws.layout?.panels;
          if (lp && typeof lp === "object") {
            for (const [id, v] of Object.entries(lp)) panels[id] = v;
          }
        }
        return panels;
      } catch {
        return null;
      }
    }, LAYOUT_STORAGE_KEY);
    if (aggregated && Object.keys(aggregated).length === expectedTotalPanelCount) {
      return aggregated as Record<string, { params?: { url?: string; label?: string } }>;
    }
    await page.waitForTimeout(80);
  }
  throw new Error(
    `saved layout with ${expectedTotalPanelCount} total panels never appeared in localStorage within ${timeoutMs}ms`,
  );
}

/** The `.src` of every pane iframe, in DOM order (defense-in-depth check: a
 *  poisoned `javascript:` url must never reach an unsandboxed iframe.src). */
export async function iframeSrcs(page: Page): Promise<string[]> {
  return page.locator("iframe.pane-iframe").evaluateAll((els) =>
    (els as HTMLIFrameElement[]).map((e) => e.src),
  );
}
