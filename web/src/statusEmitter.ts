// Session-attention status emitter (embed-gated) for the production SPA.
//
// P1 session-attention layer. Mirrors the heartbeat/route bridge's security
// pattern EXACTLY (see heartbeat.ts): embed gate (`window.parent === window` →
// no-op), inbound source-guard (`ev.source !== window.parent` → reject), and
// captured-origin targeting (`hostOrigin` from the inbound handshake, NEVER
// `'*'`). When embedded by the vh-solara host shell, it derives the current
// `(dir, session)`'s attention + activity from the sync store and posts a
// `{type:"status",...}` message idempotent-on-change so the host can decorate
// each pane with operator-action indicators (distinct from the Q1-C
// document-liveness dot).
//
// Threat model + payload boundary: identical to the route emission. `dir`+
// `session` are the SPA's declared non-sensitive routing vocabulary; `title` is
// OpenCode-authored plain session/project text (no transcript/URL/content). No
// last-assistant-line preview, no `changedAt` timestamp (the SPA has no
// per-field attention-changed-at source — fabricating one is forbidden).
//
// The host derives `serverId` from the iframe source (pane keyed by
// contentWindow) and IGNORES any sender-claimed id — so this emitter sends only
// `{dir, session}`, matching the route bridge exactly.
//
// This is ADDITIVE: it does not change the physical topology, the heartbeat, or
// the Q1-C liveness indicator. Survival is unchanged.

import { isEmbedded } from "./embedded";
import { state } from "./sync/store";
import { rootOf, sessionWorking } from "./sync/selectors";
import { chatTailFollowing } from "./tailFollow";

// Attention is emit-on-change, not a latency-critical cursor: 1 Hz is the right
// cadence (sub-second detection of a needs-permission transition without the
// 4 Hz churn of the heartbeat, which must be frequent for its staleness window).
const STATUS_POLL_MS = 1000;

export type Attention = "none" | "needs_reply" | "needs_permission";
export type Activity = "running" | "idle" | "done_unread" | "error" | "unknown";

export interface StatusMessage {
  type: "status";
  dir: string;
  session: string;
  title: string;
  attention: Attention;
  activity: Activity;
  /**
   * Whether the chat view is currently following the transcript tail (Live) or
   * reading history (following=false). Derived from the active ChatView via the
   * tailFollow bridge — `true` when no chat is mounted / no session is open
   * (nothing is being not-followed). Part of the idempotence key, so a
   * following flip re-emits and the host's tail indicator tracks the operator
   * scrolling inside the pane.
   */
  following: boolean;
}

/**
 * Reconstruct the SPA's current deep-link target carrying ONLY the known
 * non-sensitive params (dir, session) — the same vocabulary + allowlist as the
 * route bridge (`heartbeat.ts` `allowlistRoute`). Returns `dir`/`session` as
 * plain strings ("" / "" when absent). If the routing vocabulary grows, extend
 * BOTH this and `allowlistRoute` together.
 */
function currentTarget(): { dir: string; session: string } {
  try {
    const p = new URLSearchParams(window.location.search);
    return { dir: p.get("dir") ?? "", session: p.get("session") ?? "" };
  } catch {
    return { dir: "", session: "" };
  }
}

/**
 * Derive the attention state for a session. P1 NEW SPLIT LOGIC: reads the
 * `permissions` and `questions` maps DIRECTLY (does NOT reuse `sessionNeedsInput`,
 * which OR-s the two and cannot distinguish them). `needs_permission` takes
 * priority over `needs_reply` when both are present — a capability-bearing
 * permission request (e.g. a bash command approval) is the more urgent ask.
 */
function deriveAttention(session: string): Attention {
  if (Object.keys(state.permissions[session] ?? {}).length > 0) {
    return "needs_permission";
  }
  if (Object.keys(state.questions[session] ?? {}).length > 0) {
    return "needs_reply";
  }
  return "none";
}

/**
 * Derive the activity state for a session. Maps directly onto the explicit
 * store sources (no field ships `unknown` as a guess — only the honest "session
 * not resident / authoritativeReady false" case). Precedence is operator-
 * sensible: unknown (honesty first) → error (terminal own-state) → running
 * (busy/retry/subtreeBusy via `sessionWorking`) → done_unread (authoritative
 * root-scoped server watermark) → idle → unknown fallback.
 */
function deriveActivity(session: string): Activity {
  // Honesty first: before the authoritative capture lands or the session is
  // resident, we do not have trustworthy state. "unknown" is NOT a guess.
  if (!state.authoritativeReady) return "unknown";
  if (!state.sessions[session]) return "unknown";
  const act = state.activity[session];
  if (act === "error") return "error";
  // sessionWorking = own busy/retry OR server-computed subtreeBusy (a running
  // descendant keeps the parent "working"). This is the same selector the chat
  // uses (selectors.ts:139-147).
  if (sessionWorking(session)) return "running";
  // done_unread: authoritative server watermark on the ROOT (unread is
  // root-scoped). Checked before idle so a finished-unread session reads
  // "done_unread", not "idle".
  if (state.unread[rootOf(session)]) return "done_unread";
  if (act === "idle") return "idle";
  return "unknown";
}

/**
 * Install the embed-gated status emitter. Captures the host origin from the
 * inbound handshake (same listener shape as `heartbeat.ts`), then polls the
 * store + URL at 1 Hz and posts a `{type:"status"}` message ONLY when the
 * derived `{dir,session,title,attention,activity}` tuple changes
 * (idempotent-on-change — NOT an unbounded event log). No-op when standalone.
 *
 * Returns a disposer that removes the listener + clears the interval (the
 * emitter otherwise lives for the document lifetime; a reload re-runs this
 * module). The disposer is captured by index.tsx for hygiene; like
 * `startHeartbeat`, the entrypoint does not wire HMR disposal.
 */
export function startStatusEmitter(): (() => void) | undefined {
  if (typeof window === "undefined") return;
  // Constraint #1 (mirror heartbeat): embed gate. Send nothing standalone.
  if (!isEmbedded()) return;

  // Q2-A (mirror heartbeat): host origin captured from the inbound handshake
  // MessageEvent.origin — never a literal '*' and never build-time config.
  let hostOrigin: string | null = null;
  // Idempotent-on-change key. The host keeps last-known per pane; this emitter
  // keeps last-sent locally so it posts only on a genuine tuple change.
  let lastKey: string | null = null;

  const onMessage = (ev: MessageEvent): void => {
    const data = ev.data as { type?: string } | null;
    if (!data || data.type !== "vh-host-handshake") return;
    // F1 (mirror heartbeat): inbound source-guard. Only the actual parent
    // window may establish the reply target; an untrusted sibling pane grabbing
    // this window's WindowProxy must not capture the attacker's origin.
    if (ev.source !== window.parent) return;
    hostOrigin = ev.origin;
    // C-F1: reset the change-detection key so the next tick re-emits the current
    // status. After a host-shell reload the iframes survive (renderer:'always'),
    // so the SPA document is unchanged and `lastKey` still holds the pre-reload
    // status key — without this reset the emitter would (wrongly) consider the
    // current status already-emitted and the host's IN-MEMORY `statusByPane`
    // (which is NOT persisted, unlike route, so it is lost on host reload) would
    // stay empty while the heartbeat recovers, silently dropping attention
    // badges. Reset here in the handshake listener (same place heartbeat.ts
    // captures hostOrigin) so the next 1 Hz tick re-posts. (Route tracking in
    // heartbeat.ts does NOT reset its lastRoute on re-handshake because route is
    // persisted + restored independently by the host; status is not persisted,
    // hence the asymmetry.)
    lastKey = null;
  };
  window.addEventListener("message", onMessage);

  const tick = (): void => {
    // Hold off until the host has handshaked (origin captured). Keeps every
    // reply origin-bound (Q2-A).
    if (hostOrigin === null) return;
    const { dir, session } = currentTarget();
    // When the SPA has no active session (project view, no session open), there
    // is no attention target: report the honest no-target state. This clears
    // the host's pane indicator when the operator navigates away from a session
    // and re-establishes it on return (idempotent-on-change handles the round
    // trip because session is part of the key).
    const attention: Attention = session ? deriveAttention(session) : "none";
    const activity: Activity = session ? deriveActivity(session) : "unknown";
    const title: string = session ? (state.sessions[session]?.title ?? "") : "";
    // Tail-follow is a CHAT-VIEW property (per open chat), not per-session
    // state: when no session is open there is no transcript to not-follow, so
    // the honest value is true. Read through the tailFollow bridge (unbound →
    // true). In the idempotence key, so a following flip re-emits.
    const following: boolean = session ? chatTailFollowing() : true;
    const key = `${dir}\u0000${session}\u0000${title}\u0000${attention}\u0000${activity}\u0000${following}`;
    if (key === lastKey) return; // idempotent-on-change
    lastKey = key;
    const msg: StatusMessage = { type: "status", dir, session, title, attention, activity, following };
    try {
      // Q2-A: targeted to the captured host origin — never '*'.
      window.parent.postMessage(msg, hostOrigin);
    } catch {
      /* parent window gone — ignore */
    }
  };

  const id = window.setInterval(tick, STATUS_POLL_MS);

  return () => {
    window.removeEventListener("message", onMessage);
    if (typeof window !== "undefined") window.clearInterval(id);
  };
}
