// Notification orchestration: turns raw store changes into user-facing pings and
// acks. The stream calls in here as activity/permission/question events land;
// the rules (ping a root once when its whole subtree settles, clear the
// "waiting" nudge when input is answered, ack on read) live here so the stream
// state-machine stays about transport, not policy.
import { pushNotification, markRead } from "../notify";
import { attendingNow } from "../alerts";
import { state, setState, selectedId } from "./store";
import { rootOf, sessionWorking, sessionNeedsInput } from "./selectors";

// Surface an assistant error as a dismissable notification.
export function notifyFromMessage(payload: any) {
  const info = payload?.info;
  const err = info?.error;
  if (info?.role === "assistant" && err) {
    pushNotification({
      kind: "error",
      sessionID: info.sessionID,
      title: "errored",
      detail: err.data?.message || err.name || "Assistant error",
    });
  }
}

// Once a session's subtree has no more pending input, mark its "waiting" nudge
// read (the daemon's notice is keyed by the root session id).
export function maybeClearWaiting(sessionID: string) {
  const root = rootOf(sessionID);
  if (!sessionNeedsInput(root)) {
    markRead((n) => n.kind === "waiting" && n.sessionID === root);
  }
}

// Acknowledge a session as read (called when its bottom is reached): clears the
// finished-unread flag on its root, server-side (cross-device) + optimistically.
//
// `opts.force` (used only from the maybeRestore no-anchor open path) sends the
// POST /vh/ack unconditionally: that path can race ahead of Stream-1 arming the
// FE unread flag on a fresh page load, so the armed guard below would skip the
// POST and the server-side dot would never clear (open-at-bottom race,
// P1-WEB-005). The server's clearUnreadLocked is idempotent (no-op when the
// root is not unread), so a forced POST is safe. The optimistic local clear
// stays guarded by `armed` to avoid spurious non-unread clears.
export function ackSession(id: string, opts?: { force?: boolean }) {
  if (!id) return;
  const root = rootOf(id);
  // Viewing a session acks ALL of its notifications (any kind) — but only when
  // the user is actually PRESENT. Leaving the PWA open on a session while away
  // (idle/backgrounded) must not silently mark its nudges read; that's the whole
  // point of the alert. Explicit actions (answering, archiving) ack regardless.
  if (attendingNow()) markRead((n) => (n.sessionID || "") === root);
  const armed = !!state.unread[root];
  if (!armed && !opts?.force) return; // nothing more to ack (finished-unread flag)
  if (armed) setState("unread", root, undefined as unknown as boolean);
  void fetch("/vh/ack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionID: id }),
  }).catch(() => {});
}

// Per-root "was its subtree working" memory, used to ping exactly once when a
// root task fully completes (root + all its subagents idle). Subsession-level
// completions never ping — only the root does.
const rootWorking = new Map<string, boolean>();
// Pending "finished" timers, keyed by root. A turn can dip idle for a moment
// between steps (one step finishes, the next hasn't escalated to busy yet), so
// we don't ping the instant the subtree reads idle — we wait for the idle to
// SETTLE. If the root goes busy again before the timer fires, the run wasn't
// actually done and we cancel, so a multi-step turn pings exactly once at the end.
const doneTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DONE_SETTLE_MS = 4000;
export function maybeNotifyRootDone(changedSessionID: string) {
  const root = rootOf(changedSessionID);
  const nowWorking = sessionWorking(root); // folds in descendant activity
  const was = rootWorking.get(root) ?? false;
  rootWorking.set(root, nowWorking);
  if (nowWorking) {
    // Back to work (or still working): cancel any pending "finished" ping.
    const t = doneTimers.get(root);
    if (t !== undefined) {
      clearTimeout(t);
      doneTimers.delete(root);
    }
    return;
  }
  // Settled to idle: the transient "still working" alerts (stuck-thinking,
  // runaway command, stalled) for this root no longer hold — ack them.
  markRead((n) => (n.sessionID || "") === root && (n.tag === "stuck-thinking" || n.tag === "runaway" || n.tag === "stalled"));
  // Just settled into idle: schedule the ping, but only if it stays idle long
  // enough that this is a real turn-end and not a between-steps dip.
  if (was && !doneTimers.has(root)) {
    const t = setTimeout(() => {
      doneTimers.delete(root);
      if (!sessionWorking(root) && root !== selectedId()) {
        pushNotification({ kind: "done", sessionID: root, title: "finished" });
      }
    }, DONE_SETTLE_MS);
    doneTimers.set(root, t);
  }
}
