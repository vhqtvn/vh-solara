import { createEffect, createRoot, createSignal } from "solid-js";
import type { Attention } from "./dockview/types";
import {
  firstNeedsYouAtFor,
  needsYouByWs,
  statusFor,
  workspaces,
  workspaceApiFor,
} from "./dockview/store";

// =============================================================================
// PWA NEEDS-YOU ATTENTION NOTIFICATIONS (v1).
//
// Fires OS notifications when a pane's session needs the operator (permission
// or reply), with per-pane dedupe, a persistent summary notification, and
// app-badge where supported. ALIVE-TAB SEMANTICS: no push; works while the
// host tab is open or backgrounded, not after close.
//
// PLATFORM BASIS (probe-proven on the operator's Fold, Edge Android 151 +
// Chrome — treated as ground truth; see the dispatch platform facts):
//   1. Android has NO numeric app badge — setAppBadge/clearAppBadge resolve as
//      NO-OPs there (they DO render on desktop installs). We call them anyway
//      (desktop bonus) and never depend on them.
//   2. The Android "indicator" is a PERSISTENT ACTIVE NOTIFICATION in the
//      shade — that is exactly what the summary notification below is.
//   3. Android REQUIRES ServiceWorkerRegistration.showNotification(); the
//      `new Notification()` constructor throws there. Every notification here
//      goes through the SW registration — never the page constructor.
//   4. The root SW (/sw.js, scope /) is registration-persistent and
//      origin-wide; its fetch handler route-excludes / and /host/* (host
//      passthrough — zero interference).
//   5. SW notifications attribute to the installed root app; clicks switch to
//      it (the sw.js notificationclick handler focuses an existing window).
//   6. Same-tag showNotification REPLACES; distinct tags are separate shade
//      entries; getNotifications({tag}) + close() cleans up.
//
// REVERSIBLE DEFAULTS (all flagged, all cheap to flip):
//   - OPT-IN default OFF (absent key = off; notifications deserve consent).
//   - VISIBILITY GATE: the per-pane heads-up is suppressed while
//     document.visibilityState === "visible" (the operator is looking at the
//     host — the tab badges + NEXT already show the need); pending fires
//     flush on the next visibilitychange→hidden. The SUMMARY notification is
//     maintained regardless of visibility (it IS the shade indicator).
//   - NO AUTO-NEXT on notification click: the SW click just focuses the app;
//     the operator taps NEXT (which re-derives fresh ranking). Routing to a
//     specific pane from a (possibly stale) notification payload was
//     considered and deferred — always fresh state.
//   - SW REGISTRATION ON ENABLE, not unconditionally: the host registers
//     /sw.js (idempotent, scope /) when the persisted toggle is ON at boot
//     and on first enable. A device that never opted in never grows a host-SW
//     registration it does not use; the SPA registers the same SW anyway.
//   - CLEANUP ON UNLOAD IS NOT ATTEMPTED (cannot reliably intercept); shade
//     entries persist until the need resolves or the operator dismisses them.
//     When attention resolves (all needy → none), we CLOSE the summary + our
//     per-pane notifications via getNotifications({tag}) + close().
//
// STRUCTURE: pure core (episodeDiff / summaryNotification / perPaneSuppressed
// — no side effects, exported for the DEV bridge's unit-level probes) + a thin
// side-effect shell (reactive evaluation + SW calls + badge + toggle). The
// host-web package has NO unit runner (see package.json), so the pure parts
// are asserted through the DEV bridge in tests/e2e/attention-notify.spec.ts —
// the same "pure math via bridge" precedent as proportions.spec.ts.
// =============================================================================

// ---- pure core --------------------------------------------------------------

/** A pane currently in a needs-you state (one notification episode each). */
export interface NeedyPane {
  paneId: string;
  /** Pane label ("server · view", e.g. "srv-A · chat") — the notification title. */
  label: string;
  attention: Exclude<Attention, "none">;
  /** Host-latched none→non-none timestamp (ranking tiebreak, mirrors NEXT). */
  firstNeedsYouAt: number;
}

/** What an attention-set change means for per-pane notification episodes. */
export type EpisodeAction =
  | { kind: "fire"; pane: NeedyPane } // attention none → needs_you: a NEW episode starts
  | { kind: "close"; paneId: string }; // needs_you → none/gone: the episode resolved

/**
 * Diff two needy sets into episode actions. FIRES only on the none→needy edge:
 * a needs_reply → needs_permission change WITHIN a continuous needy interval
 * produces NO action (one heads-up per episode; the kind never re-fires).
 * Closes on the needy→none edge (including the pane unregistering/disappearing
 * from the live workspace apis). Pure + deterministic.
 */
export function episodeDiff(
  prev: Map<string, NeedyPane>,
  next: Map<string, NeedyPane>,
): EpisodeAction[] {
  const actions: EpisodeAction[] = [];
  for (const [id, pane] of next) {
    if (!prev.has(id)) actions.push({ kind: "fire", pane });
  }
  for (const id of prev.keys()) {
    if (!next.has(id)) actions.push({ kind: "close", paneId: id });
  }
  return actions;
}

/** Stable per-pane notification tag (same-tag shows REPLACE on the platform). */
export function paneTag(paneId: string): string {
  return `vh-needy-${paneId}`;
}
/** Tag of the persistent summary notification (the Android shade indicator). */
export const SUMMARY_TAG = "vh-needy-summary";

/** The notification body for an attention kind. */
export function needyBody(attention: Exclude<Attention, "none">): string {
  return attention === "needs_permission"
    ? "Waiting for permission"
    : "Waiting for your reply";
}

/** Cap on labels listed in the summary body (then "…"). */
const SUMMARY_LABEL_CAP = 3;

/**
 * The summary notification for a needy set (null when empty). Count + body are
 * derived from the GIVEN list — callers pass the globally-ranked set (see
 * enumerateNeedy) so the first labels are the most urgent. Pure.
 */
export function summaryNotification(
  needy: NeedyPane[],
): { count: number; title: string; body: string } | null {
  if (needy.length === 0) return null;
  const count = needy.length;
  const title = count === 1 ? "1 needs you" : `${count} need you`;
  const shown = needy.slice(0, SUMMARY_LABEL_CAP).map((n) => n.label);
  const body = shown.join(", ") + (count > SUMMARY_LABEL_CAP ? " …" : "");
  return { count, title, body };
}

/**
 * VISIBILITY GATE (reversible default): per-pane heads-ups are suppressed
 * while the document is visible; the summary is NEVER suppressed (it is the
 * shade indicator, useful in both foreground and background). Pure.
 */
export function perPaneSuppressed(visibilityState: string): boolean {
  return visibilityState === "visible";
}

// ---- toggle (localStorage-backed, opt-in) ------------------------------------

/** localStorage key (versioned). Values "on"/"off"; ABSENT = OFF (opt-in). */
export const ATTENTION_NOTIFY_STORAGE_KEY = "vh-host:attentionNotify:v1";

/** True iff needs-you notifications are enabled (absent key → OFF). */
export function attentionNotifyEnabled(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(ATTENTION_NOTIFY_STORAGE_KEY) === "on";
}

// Reactive mirror (same pattern as viewportShape.autoTransposeOn): the storage
// stays the source of truth; same-document writes (setAttentionNotifyEnabled,
// including the DEV bridge) and cross-document writes (storage event) both
// refresh the signal so the Settings checkmark never goes stale while open.
const [enabledState, setEnabledState] = createSignal(attentionNotifyEnabled());

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (ev: StorageEvent) => {
    if (ev.key !== ATTENTION_NOTIFY_STORAGE_KEY) return;
    setEnabledState(attentionNotifyEnabled());
  });
}

/** Reactive view of the toggle (tracks every writer). */
export function attentionNotifyOn(): boolean {
  return enabledState();
}

// ---- enable-with-permission flow (driven by the Settings toggle click) -------

/** Why the needs-you toggle could not switch on (null when no hint to show). */
type NotifyHintKind = null | "denied" | "declined" | "unavailable";
const [hintState, setHintState] = createSignal<NotifyHintKind>(null);

/** Inline hint text for the Settings item (null → no hint rendered). */
export function attentionNotifyHint(): string | null {
  const h = hintState();
  if (h === "denied") {
    return "Blocked — allow notifications for this site in your browser settings, then try again.";
  }
  if (h === "declined") return "Permission wasn't granted. Tap again to retry.";
  if (h === "unavailable") return "Notifications aren't supported in this browser.";
  return null;
}

/**
 * Enable needs-you notifications from a USER GESTURE (the Settings click).
 * - permission "granted"  → enable.
 * - permission "default"  → Notification.requestPermission() (the click IS
 *   the gesture); enable on grant, hint + stay off otherwise.
 * - permission "denied"   → hint pointing at browser settings; stay off.
 * Returns true iff the toggle ended up ON. No auto-prompt anywhere else —
 * this is the ONLY permission surface (opt-in by design).
 */
export async function requestEnableAttentionNotify(): Promise<boolean> {
  if (typeof Notification === "undefined") {
    setHintState("unavailable");
    return false;
  }
  if (Notification.permission === "granted") {
    setAttentionNotifyEnabled(true);
    return true;
  }
  if (Notification.permission === "denied") {
    setHintState("denied");
    return false;
  }
  let perm: string = "default";
  try {
    perm = await Notification.requestPermission();
  } catch {
    setHintState("denied");
    return false;
  }
  if (perm === "granted") {
    setAttentionNotifyEnabled(true);
    return true;
  }
  setHintState(perm === "denied" ? "denied" : "declined");
  return false;
}

// ---- side-effect shell (singleton; one manager per host window) --------------

/** One manager decision, for the DEV-bridge fired-log (DEV builds only). */
export interface NotifyLogEntry {
  op: "show" | "close" | "suppressed" | "badge" | "badge-clear" | "register" | "error";
  tag?: string;
  title?: string;
  body?: string;
  count?: number;
}

/** Episode bookkeeping: paneId → whether its notification was actually SHOWN
 *  (false = suppressed-by-visibility, pending the next hidden flush). */
interface EpisodeRecord {
  fired: boolean;
}

let installed = false;
let rootDispose: (() => void) | null = null;
let visibilityListener: (() => void) | null = null;
/** The needy set as of the last evaluation (episode-diff base). */
let prevSet = new Map<string, NeedyPane>();
/** Open notification episodes (only panes currently needy AND enabled). */
const episodes = new Map<string, EpisodeRecord>();
/** Whether WE currently hold a summary notification in the shade. */
let summaryShown = false;
/** Last summary content (dedupes no-op re-shows between evaluations). */
let lastSummaryKey = "";
/** Last badge value applied (dedupes no-op badge calls). */
let lastBadge: number | null = null;
/** DEV-only decision log (never written in production builds). */
const log: NotifyLogEntry[] = [];
const keepLog = import.meta.env.DEV;

function note(entry: NotifyLogEntry): void {
  if (!keepLog) return;
  log.push(entry);
}

/** DEV-ONLY visibility override (the real visibilitychange OUTCOME is not
 *  headlessly demonstrable — Playwright pages stay "visible"; the override
 *  lets the e2e prove the MECHANISM, the kbdFocusOpen precedent). Prod null. */
let visibilityOverride: boolean | null = null;

function isHiddenNow(): boolean {
  if (visibilityOverride !== null) return visibilityOverride;
  return typeof document !== "undefined" && document.visibilityState !== "visible";
}

// Attention priority, mirroring attentionNext.ATTENTION_RANK (needs_permission
// before needs_reply so the summary lists the most urgent pane first).
const NEEDY_RANK: Record<Exclude<Attention, "none">, number> = {
  needs_permission: 0,
  needs_reply: 1,
};

/**
 * Enumerate every needs-you pane across ALL workspaces (GLOBAL, not
 * active-only — the same scope attentionNext.rankNeedy ranks and
 * recomputeAggregates counts per-ws), with each pane's LABEL for the
 * notification title. Mirrors rankNeedy()'s pane→ws mapping
 * (workspaceApiFor(wsId).panels) + statusFor; ranked identically (attention,
 * then oldest-first, then paneId) so the summary body is most-urgent-first.
 * Pure/read-only — no side effects.
 */
function enumerateNeedy(): NeedyPane[] {
  const out: NeedyPane[] = [];
  for (const ws of workspaces()) {
    const api = workspaceApiFor(ws.id);
    if (!api) continue;
    for (const panel of api.panels) {
      const st = statusFor(panel.id);
      if (!st || st.attention === "none") continue;
      const params = (panel.params ?? {}) as { label?: string };
      const label = params.label || st.title || panel.id;
      out.push({
        paneId: panel.id,
        label,
        attention: st.attention,
        firstNeedsYouAt: firstNeedsYouAtFor(panel.id) ?? 0,
      });
    }
  }
  out.sort((a, b) => {
    if (a.attention !== b.attention) {
      return NEEDY_RANK[a.attention] - NEEDY_RANK[b.attention];
    }
    if (a.firstNeedsYouAt !== b.firstNeedsYouAt) {
      return a.firstNeedsYouAt - b.firstNeedsYouAt; // oldest first
    }
    return a.paneId < b.paneId ? -1 : a.paneId > b.paneId ? 1 : 0;
  });
  return out;
}

// ---- service-worker plumbing --------------------------------------------------

/** The active SW registration, or null when unavailable. `ready` resolves to
 *  the origin's active registration (platform fact #4 — registration-
 *  persistent; the SPA registers the same /sw.js). Never rejects in practice;
 *  a dev server without /sw.js simply never resolves (we degrade quietly). */
function swReady(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return Promise.resolve(null);
  }
  return navigator.serviceWorker.ready.catch(() => null);
}

/**
 * Ensure /sw.js is registered (idempotent by spec — same script URL returns
 * the existing registration; scope /). Registration choice documented in the
 * header: gated on the toggle being ON (boot with the persisted key "on", and
 * first enable) — never unconditional. Closes the host-only-user gap (never
 * visited /app → no registration → serviceWorker.ready never resolves).
 */
function ensureServiceWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  note({ op: "register" });
  try {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // Vite dev servers don't serve /sw.js (404) — degrade quietly; the
      // notification calls then simply never land (ready never resolves).
    });
  } catch {
    // register() threw synchronously (unsupported) — degrade quietly.
  }
}

/**
 * Show ONE notification through the SW registration (platform fact #3: the
 * page Notification constructor throws on Android; the SW path works
 * everywhere the SW exists). Same-tag shows REPLACE (fact #6).
 */
async function showNotification(
  tag: string,
  title: string,
  body: string,
): Promise<void> {
  note({ op: "show", tag, title, body });
  try {
    const reg = await swReady();
    if (!reg) return;
    await reg.showNotification(title, { tag, body });
  } catch {
    note({ op: "error", tag });
  }
}

/** Close every notification currently holding `tag` (fact #6 cleanup path). */
async function closeTag(tag: string): Promise<void> {
  note({ op: "close", tag });
  try {
    const reg = await swReady();
    if (!reg) return;
    const list = await reg.getNotifications({ tag });
    for (const n of list) n.close();
  } catch {
    note({ op: "error", tag });
  }
}

/** Badge alongside (platform fact #1: a silent NO-OP on Android; desktop
 *  bonus). Guarded — the methods may be absent; never throws. */
function updateBadge(count: number): void {
  if (count === lastBadge) return;
  lastBadge = count;
  try {
    const nav = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (count > 0) {
      note({ op: "badge", count });
      void nav.setAppBadge?.(count);
    } else {
      note({ op: "badge-clear" });
      void nav.clearAppBadge?.();
    }
  } catch {
    // Badge APIs missing — ignored by design.
  }
}

function showPaneNotification(pane: NeedyPane): void {
  void showNotification(paneTag(pane.paneId), `${pane.label} needs you`, needyBody(pane.attention));
}

// ---- evaluation ----------------------------------------------------------------

/**
 * One evaluation over the current global needy set. Runs inside a reactive
 * effect (tracks needsYouByWs — recomputed by the store on EVERY status store,
 * pane-list change, unregister, and workspace close) and on demand (enable,
 * visibility flush). While DISABLED it only keeps the diff base current (no
 * actions) so a later enable never fires for needs that predate it.
 */
function evaluate(): void {
  const needy = enumerateNeedy();
  const next = new Map(needy.map((n) => [n.paneId, n] as const));
  const actions = episodeDiff(prevSet, next);
  prevSet = next;

  if (!enabledState()) {
    // Keep episode bookkeeping coherent across the disabled window: resolved
    // panes simply drop (nothing was shown while disabled).
    for (const a of actions) {
      if (a.kind === "close") episodes.delete(a.paneId);
    }
    return;
  }

  for (const a of actions) {
    if (a.kind === "fire") {
      // VISIBILITY GATE (reversible default — see header): suppress the
      // per-pane heads-up while visible; the episode stays pending and the
      // next visibilitychange→hidden flushes it (see onVisibilityChange).
      // isHiddenNow() honors the DEV override (headless pages stay "visible").
      const suppressed = perPaneSuppressed(isHiddenNow() ? "hidden" : "visible");
      episodes.set(a.pane.paneId, { fired: !suppressed });
      if (suppressed) {
        note({ op: "suppressed", tag: paneTag(a.pane.paneId) });
      } else {
        showPaneNotification(a.pane);
      }
    } else {
      const rec = episodes.get(a.paneId);
      episodes.delete(a.paneId);
      if (rec?.fired) void closeTag(paneTag(a.paneId));
    }
  }

  updateSummary(needy);
  updateBadge(needy.length);
}

/** Maintain the persistent summary notification (regardless of visibility). */
function updateSummary(needy: NeedyPane[]): void {
  const s = summaryNotification(needy);
  if (s) {
    const key = `${s.title}|${s.body}`;
    if (summaryShown && key === lastSummaryKey) return; // no-op re-show guard
    void showNotification(SUMMARY_TAG, s.title, s.body);
    summaryShown = true;
    lastSummaryKey = key;
  } else if (summaryShown) {
    void closeTag(SUMMARY_TAG);
    summaryShown = false;
    lastSummaryKey = "";
  }
}

/** visibilitychange listener: on →hidden, flush per-pane heads-ups that the
 *  visibility gate had suppressed (the operator left with unresolved needs —
 *  this is what makes "background the host, observe heads-up" work even when
 *  the need STARTED while visible). →visible needs no action (the summary is
 *  maintained regardless of visibility). */
function onVisibilityChange(): void {
  if (!enabledState()) return;
  if (!isHiddenNow()) return;
  for (const [id, rec] of episodes) {
    if (rec.fired) continue;
    rec.fired = true;
    const pane = prevSet.get(id);
    if (pane) showPaneNotification(pane);
  }
}

/** Toggle setter side effects. ON: register the SW (host-only-user gap) and
 *  evaluate immediately (the summary + badge reflect pre-existing needs; no
 *  per-pane heads-ups for them — those only fire for NEW episodes). OFF:
 *  "off means off" — close everything we own + clear the badge. */
function onEnabled(): void {
  ensureServiceWorker();
  evaluate();
}
function onDisabled(): void {
  for (const [id, rec] of episodes) {
    if (rec.fired) void closeTag(paneTag(id));
  }
  episodes.clear();
  if (summaryShown) {
    void closeTag(SUMMARY_TAG);
    summaryShown = false;
    lastSummaryKey = "";
  }
  updateBadge(0);
}

/**
 * Set the toggle. Persists immediately, refreshes the reactive mirror, and
 * runs the enable/disable side effects. This is the production setter the
 * Settings item AND the DEV bridge both route through.
 */
export function setAttentionNotifyEnabled(on: boolean): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(ATTENTION_NOTIFY_STORAGE_KEY, on ? "on" : "off");
  }
  setEnabledState(on);
  setHintState(null);
  if (on) onEnabled();
  else onDisabled();
}

// ---- DEV bridge (window.__hostAttention) --------------------------------------
// Mirrors __hostViewport: the ENTIRE bridge (incl. the visibility override +
// the decision log) is gated behind import.meta.env.DEV so production builds
// never expose it (Vite dead-code-eliminates; the preview-e2e asserts absence).

interface AttentionDevBridge {
  /** Read the on/off toggle. */
  enabled(): boolean;
  /** Set the on/off toggle through the PRODUCTION setter (side effects incl.). */
  setEnabled(on: boolean): void;
  /** Current Notification.permission as the page sees it. */
  permission(): string;
  /** The Settings inline-hint text (null when none). */
  hint(): string | null;
  /** The manager decision log (show/close/suppressed/badge/register/error). */
  log(): NotifyLogEntry[];
  clearLog(): void;
  /** Force an immediate evaluation (deterministic, no signal change needed). */
  evaluateNow(): void;
  /** Override the visibility read (null = real document.visibilityState).
   *  Mechanism-proof for headless e2e; prod never sets this. */
  setHidden(hidden: boolean | null): void;
  /** Unit-level probes of the PURE core (host-web has no unit runner — these
   *  are the pure functions, callable with synthetic inputs). */
  pure: {
    episodeDiff(
      prev: Array<[string, NeedyPane]>,
      next: Array<[string, NeedyPane]>,
    ): EpisodeAction[];
    summary(list: NeedyPane[]): { count: number; title: string; body: string } | null;
    body(attention: "needs_reply" | "needs_permission"): string;
    paneTag(paneId: string): string;
    perPaneSuppressed(visibilityState: string): boolean;
  };
}

const DEV_BRIDGE_KEY = "__hostAttention";

function installDevBridge(): void {
  if (!import.meta.env.DEV) return;
  const bridge: AttentionDevBridge = {
    enabled: () => attentionNotifyEnabled(),
    setEnabled: (on) => setAttentionNotifyEnabled(on),
    permission: () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission),
    hint: () => attentionNotifyHint(),
    log: () => log.slice(),
    clearLog: () => {
      log.length = 0;
    },
    evaluateNow: () => evaluate(),
    setHidden: (h) => {
      visibilityOverride = h;
    },
    pure: {
      episodeDiff: (prev, next) => episodeDiff(new Map(prev), new Map(next)),
      summary: (list) => summaryNotification(list),
      body: (a) => needyBody(a),
      paneTag: (id) => paneTag(id),
      perPaneSuppressed: (v) => perPaneSuppressed(v),
    },
  };
  (window as unknown as Record<string, unknown>)[DEV_BRIDGE_KEY] = bridge;
}

function removeDevBridge(): void {
  if (!import.meta.env.DEV) return;
  delete (window as unknown as Record<string, unknown>)[DEV_BRIDGE_KEY];
}

// ---- install / uninstall (mirrors viewportShape.ts) ---------------------------

/**
 * Install the needs-you notification manager. Creates the reactive evaluation
 * (a dedicated root so uninstall can dispose it cleanly), the visibilitychange
 * listener, and the DEV bridge. If the persisted toggle is ON at boot, ensures
 * the /sw.js registration (see the registration choice in the header). No-op
 * in non-browser environments. Idempotent.
 */
export function installAttentionNotify(): void {
  if (installed) return;
  if (typeof window === "undefined") return;
  installed = true;
  if (attentionNotifyEnabled()) ensureServiceWorker();
  rootDispose = createRoot((dispose) => {
    createEffect(() => {
      // Track the store's per-workspace needs-you signal — it is recomputed on
      // EVERY status store / pane-list change / unregister / workspace close,
      // so this effect re-runs exactly when the needy set could have changed.
      void needsYouByWs();
      evaluate();
    });
    return dispose;
  });
  visibilityListener = onVisibilityChange;
  document.addEventListener("visibilitychange", visibilityListener);
  installDevBridge();
}

/** Tear down the manager (root dispose + listeners + DEV bridge). Used on
 *  hot-reload / unmount so nothing fires after teardown. */
export function uninstallAttentionNotify(): void {
  if (!installed) return;
  installed = false;
  rootDispose?.();
  rootDispose = null;
  if (visibilityListener) {
    document.removeEventListener("visibilitychange", visibilityListener);
    visibilityListener = null;
  }
  removeDevBridge();
}
