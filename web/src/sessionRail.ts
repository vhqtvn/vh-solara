// Portrait session monitor rail — derivation module (P1).
//
// The RAIL is a 48px vertical column of per-session avatars that persists in
// the NARROW width tier (<560 visual px) beside the chat, so an operator on a
// phone can see every root session's state and jump between them without
// opening the covering drawer. Component: components/SessionRail.tsx; this
// module owns the DERIVATIONS so they are unit-testable without the DOM.
//
// GRANULARITY (operator directive, tab-pairs precedent — statusEmitter.ts
// derivePaneCounts): the rail enumerates ROOT sessions ONLY. A subsession is
// represented by its root's avatar (its attention rolls up into the root via
// the server-computed subtree facets). The unread watermark is root-scoped
// server-side, so enumerating roots needs no descendant de-dup.
//
// STABLE ORDER (invariant): avatars are ordered by the tree store's
// ARRIVAL order — rootNodes(treeMap()), the pure root enumeration whose
// order-preserving contract is insertion/emit order. It is stable under
// facet/upsert ops (a JS Map keeps a replaced key's position), so attention
// NEVER reorders the rail: needs-input / error / running / unread are
// expressed as RINGS on the avatar, never as position changes. This is
// deliberately NOT treeRoots(): the shell accessor rank-sorts roots and
// front-promotes a node on a non-working → working edge (an ATTENTION-driven
// jump that is the tree's designed recency UX) — inheriting it would break
// the rail's fixed-position muscle memory. New sessions append at the bottom
// (predictable, cross-device: every device applies the same snapshot emit
// order). REVERSIBLE DEFAULT (operator dial): switch to treeRoots() for
// tree-parity ordering at the cost of attention-driven jumps.
//
// Everything here is a read of server-authoritative store state (tree facets,
// activity map, permissions/questions maps, root-scoped unread) — the same
// sources the tree and statusEmitter read — so the rail is cross-device
// consistent by construction and identical embedded vs standalone (no
// isEmbedded() branch anywhere in the rail stack).
import { state } from "./sync/store";
import { sessionNeedsInput, sessionWorking } from "./sync/selectors";
import { treeMap } from "./sync/treeState";
import { rootNodes } from "./sync/treeMap";
import { isStale } from "./sync/health";
import { isUpdating } from "./sync/reconcile";

// REVERSIBLE DEFAULT (operator dials): the avatar hue palette SIZE. The hues
// themselves are the app's semantic --label-* mid-tones (tokens.css) — the
// same palette the server validates for groups/tags — consumed via the
// hueN classes in SessionRail.css so every theme keeps working.
export const RAIL_HUES = 8;

/**
 * Two-letter initials for an avatar chip. First character of the first two
 * whitespace-separated words ("Demo session" → "DS"); a single word takes its
 * first two characters ("Refactor" → "RE"). An empty/blank title falls back
 * to the session id's first two alphanumerics; a fully degenerate input
 * yields "?" so the chip never renders empty. Pure function of (title, id).
 */
export function initialsOf(title: string, id: string): string {
  const src = (title || "").trim();
  if (!src) {
    const fallback = (id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase();
    return fallback || "?";
  }
  const words = src.split(/\s+/);
  const a = words[0]?.[0] ?? "";
  const b = words[1]?.[0] ?? words[0]?.[1] ?? "";
  return (a + b).toUpperCase();
}

/**
 * Stable avatar hue index for a session id: FNV-1a 32-bit hash mod RAIL_HUES.
 * Pure function of the id — the same session gets the same color on every
 * render, every reload, and every device (ids are server-assigned).
 */
export function hueOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h) % RAIL_HUES;
}

/** One root session's avatar model. All flags are per-ROOT derivations. */
export interface RailSession {
  id: string;
  title: string;
  initials: string;
  hue: number;
  // Ring flags (priority order in ringOf): the server-computed needs-input
  // rollup (own OR subtree pending permission/question), terminal error
  // activity, the working rollup (own busy/retry OR subtreeBusy), and the
  // root-scoped finished-unread watermark.
  needsInput: boolean;
  error: boolean;
  running: boolean;
  unread: boolean;
}

/**
 * The single state ring shown on an avatar, by priority: needs-input >
 * error > running > unread. One ring per avatar (a class flip — attention is
 * never additive chrome); the selected-session ring is a SEPARATE indicator
 * on the button (see SessionRail.css) so selection and state never
 * compete for the same border.
 */
export type RailRing = "needs" | "error" | "running" | "unread" | null;
export function ringOf(s: RailSession): RailRing {
  if (s.needsInput) return "needs";
  if (s.error) return "error";
  if (s.running) return "running";
  if (s.unread) return "unread";
  return null;
}

/**
 * The rail's avatar list, in stable store (arrival) order — see the module
 * header for why this is rootNodes(treeMap()) and not the rank-sorted
 * treeRoots(). Reads the live store signals (tree version, activity, unread,
 * permissions/questions) so a Solid memo re-runs on any of them. Reactive but
 * side-effect free.
 */
export function railSessions(): RailSession[] {
  const out: RailSession[] = [];
  for (const n of rootNodes(treeMap())) {
    const title = n.title || state.sessions[n.id]?.title || n.id;
    out.push({
      id: n.id,
      title,
      initials: initialsOf(title, n.id),
      hue: hueOf(n.id),
      needsInput: sessionNeedsInput(n.id),
      error: state.activity[n.id] === "error",
      running: sessionWorking(n.id),
      unread: !!state.unread[n.id],
    });
  }
  return out;
}

/**
 * The "needs you" aggregate pinned at the rail's bottom: the number of ROOT
 * sessions needing operator attention, where a session counts ONCE whether it
 * needs input, is finished-unread, or both (the no-double-count invariant —
 * the union is computed per root, not summed per flag).
 */
export function railNeedsYou(): number {
  let count = 0;
  for (const s of railSessions()) {
    if (s.needsInput || s.unread) count++;
  }
  return count;
}

/**
 * The rail's connection-dot state — the same priority ladder the sidebar's
 * StatusMark uses (Sidebar.tsx indState): hard socket states win; within
 * "live", stale outranks syncing. One state at a time, rendered as a class
 * flip (no animation).
 */
export type RailConn = "live" | "syncing" | "stale" | "connecting" | "reconnecting";
export function railConnState(): RailConn {
  if (state.status === "reconnecting") return "reconnecting";
  if (state.status === "connecting") return "connecting";
  if (isStale()) return "stale";
  if (isUpdating() && state.status === "live") return "syncing";
  return "live";
}
