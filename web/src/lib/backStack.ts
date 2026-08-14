// Centralized back-dismissal history manager ("back stack").
//
// App-like back semantics: browser back (and Android hardware back in the PWA)
// dismisses the TOPMOST open surface and never changes the selected session.
// Every dismissible surface pushes a URL-TRANSPARENT history entry (state
// carries `{vhBack:"<tag>#<n>"}`, URL unchanged) when it opens; the entry is
// consumed when the surface is dismissed by any explicit means (✕, Escape,
// backdrop, outside-click, choosing an item). A single popstate arbiter here
// reconciles real history with a shadow stack of open surfaces:
//
//   - popstate lands on a still-open surface's token → close everything ABOVE
//     it (LIFO), keep that surface open;
//   - popstate lands on a non-token entry → close ALL live surfaces (LIFO);
//   - popstate lands on an ORPHAN token (its surface was closed
//     programmatically while buried mid-stack) → keep unwinding (history.back
//     again) until real history reconciles with the live stack;
//   - popstate lands on a DEAD token (e.g. FORWARD after a back-dismissal) →
//     strict no-op. Tokens only CLOSE surfaces, never open them.
//
// When the stack is empty, back falls through to native browser behavior (no
// exit trapping, no base sentinel). Session selection never creates history
// entries anymore (sync/url.ts replaceState), and this module's arbiter marks
// the popstate events it owns so the session-walk listener in sync.ts can
// ignore them (`wasManagedPopState`). The arbiter's listener is installed at
// module init — BEFORE sync.ts's startSync() listener — so it runs first on
// every popstate.
//
// The URL stays untouched by tokens, but a token entry freezes the URL at push
// time and syncUrl's replaceState only rewrites the topmost entry, so landing
// on a stale entry could show (or let sync apply) an outdated ?session=. The
// manager therefore repairs the URL to the canonical one on events it owns
// (`registerCanonicalRepair`, wired by sync/url.ts), preserving the landed
// entry's state be it a token or a session entry.
import { createEffect, onCleanup } from "solid-js";

export interface BackSurface {
  readonly id: string;
}

interface Surface extends BackSurface {
  close: () => void;
}

const STATE_KEY = "vhBack";

function tokenIdOf(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const v = (state as Record<string, unknown>)[STATE_KEY];
  return typeof v === "string" ? v : null;
}

/** True when `state` is a back-stack token entry (URL-transparent push). */
export function isBackEntry(state: unknown): boolean {
  return tokenIdOf(state) !== null;
}

const stack: Surface[] = [];
// Tokens whose surface was closed programmatically while their entry was
// buried mid-stack: landing on one must CONTINUE unwinding, not stall.
const orphanIds = new Set<string>();
let seq = 0;
// True while a history traversal initiated by THIS manager is in flight (the
// resulting popstate — and only that one — is manager-owned).
let pendingTraversal = false;
// Surface whose entry we are sitting on at release time; consumed (one
// history.back()) from a microtask so same-tick dismiss→open swaps can
// reclassify it as buried/orphaned before the traversal starts.
let pendingConsume: Surface | null = null;
let drainScheduled = false;
let repairUrl: (() => void) | null = null;

const managedEvents = new WeakSet<PopStateEvent>();

/**
 * Did the back-stack manager own this popstate event (token unwind, consume
 * traversal, or a back that dismissed surfaces)? Session/project re-selection
 * in sync.ts's own popstate listener must skip such events: back dismisses
 * surfaces, it never walks sessions.
 */
export function wasManagedPopState(ev: Event): boolean {
  return managedEvents.has(ev as PopStateEvent);
}

/** Register the canonical-URL repair callback (wired by sync/url.ts). */
export function registerCanonicalRepair(fn: () => void) {
  repairUrl = fn;
}

function historyOk(): boolean {
  return typeof window !== "undefined" && !!window.history;
}

function currentTokenId(): string | null {
  try {
    return tokenIdOf(window.history.state);
  } catch {
    return null;
  }
}

/**
 * Push a URL-transparent history entry for a dismissible surface. `close` is
 * invoked (at most once) when a back/forward navigation dismisses it. Returns
 * null when the History API is unavailable (the surface simply won't
 * participate — everything else keeps working).
 */
export function pushBackSurface(close: () => void, tag: string): BackSurface | null {
  if (!historyOk()) return null;
  const id = `${tag}#${++seq}`;
  try {
    window.history.pushState({ [STATE_KEY]: id }, "");
  } catch {
    return null;
  }
  const s: Surface = { id, close };
  stack.push(s);
  return s;
}

/**
 * Explicit dismissal path (✕ / Escape / backdrop / outside-click / item
 * chosen / unmount-while-open). Consumes the pushed entry so no ghost is
 * stranded; if the entry got buried by newer pushes it becomes an orphan that
 * auto-unwinds when real history walks onto it. No-op for surfaces the
 * manager already closed (popstate-driven closes remove themselves).
 */
export function releaseBackSurface(s: BackSurface | null): void {
  if (!s || !historyOk()) return;
  const i = stack.findIndex((x) => x.id === s.id);
  if (i === -1) return; // manager-driven close already retired it
  stack.splice(i, 1);
  if (orphanIds.size > 512) orphanIds.clear(); // bound pathological growth
  if (currentTokenId() === s.id) {
    if (pendingConsume && pendingConsume.id !== s.id) orphanIds.add(pendingConsume.id);
    pendingConsume = s as Surface;
    scheduleDrain();
  } else {
    orphanIds.add(s.id);
  }
}

function scheduleDrain() {
  if (drainScheduled) return;
  drainScheduled = true;
  queueMicrotask(drain);
}

function drain() {
  drainScheduled = false;
  const s = pendingConsume;
  pendingConsume = null;
  if (!s || !historyOk()) return;
  if (currentTokenId() === s.id) {
    pendingTraversal = true;
    try {
      window.history.back();
    } catch {
      /* traversal unavailable — entry stays, harmless */
    }
  } else {
    // A newer entry was pushed between release and drain: the released entry
    // is buried now, so it unwinds as an orphan instead.
    orphanIds.add(s.id);
  }
}

function invokeClose(s: Surface) {
  try {
    s.close();
  } catch {
    /* a failing close must not break the unwind loop */
  }
}

function closeAllLive(): number {
  let n = 0;
  while (stack.length) {
    const s = stack.pop()!;
    invokeClose(s);
    n++;
  }
  return n;
}

function onPopState(ev: PopStateEvent) {
  if (!historyOk()) return;
  const wasTraversal = pendingTraversal;
  pendingTraversal = false;
  const cur = currentTokenId();
  let managed = wasTraversal;
  if (cur === null) {
    // Landed on a non-token entry (app base, a legacy session entry, or a
    // foreign entry): every live surface closes, topmost first.
    managed = closeAllLive() > 0 || wasTraversal;
  } else {
    const i = stack.findIndex((x) => x.id === cur);
    if (i >= 0) {
      // Back onto a still-open surface's entry: close everything above it
      // and keep that surface open. One back = one dismissed surface.
      managed = true;
      while (stack.length - 1 > i) {
        const s = stack.pop()!;
        invokeClose(s);
      }
    } else if (orphanIds.has(cur)) {
      // Stranded mid-stack entry (programmatic close while buried): keep
      // unwinding until real history reconciles with the live stack.
      managed = true;
      orphanIds.delete(cur);
      pendingTraversal = true;
      try {
        window.history.back();
      } catch {
        /* traversal unavailable */
      }
    } else {
      // Dead token — e.g. FORWARD onto an entry whose surface was already
      // dismissed. Strict no-op: tokens only close, never open.
      managed = true;
    }
  }
  if (managed) {
    managedEvents.add(ev);
    try {
      repairUrl?.();
    } catch {
      /* repair is best-effort */
    }
  }
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  // Registered at module init, before sync.ts's startSync() listener, so this
  // arbiter classifies every popstate first.
  window.addEventListener("popstate", onPopState);
}

/**
 * Bind an open-signal to the back stack: a token is pushed while `open()` is
 * true and released when it turns false (or the owner unmounts while open).
 * `close` is only invoked by the MANAGER (back/forward dismissal); explicit
 * closes go through the signal itself.
 */
export function bindBackDismiss(open: () => boolean, close: () => void, tag: string): void {
  let s: BackSurface | null = null;
  createEffect(() => {
    if (open()) {
      if (!s) s = pushBackSurface(() => close(), tag);
    } else if (s) {
      releaseBackSurface(s);
      s = null;
    }
  });
  onCleanup(() => {
    if (s) {
      releaseBackSurface(s);
      s = null;
    }
  });
}

/**
 * Mount-bounded variant for components that only exist while open (`<Show
 * when={open}>`-gated): pushes at mount, releases at unmount. The manager may
 * invoke `close` on back; an explicit close unmounts the component, whose
 * cleanup then releases (and consumes) the entry.
 */
export function useBackEntry(close: () => void, tag: string): void {
  const s = pushBackSurface(close, tag);
  onCleanup(() => releaseBackSurface(s));
}

/** Live surface count (observability for tests/diagnostics). */
export function backStackDepth(): number {
  return stack.length;
}

/** Test-only: detach all bookkeeping without invoking closes. */
export function __resetBackStackForTest(): void {
  stack.length = 0;
  orphanIds.clear();
  pendingTraversal = false;
  pendingConsume = null;
  drainScheduled = false;
}
