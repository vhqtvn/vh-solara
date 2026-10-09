// Message-actions controller — the copy / retry / inspect / fork / undo / redo
// / abort cluster, extracted from ChatView (mirroring the other create...
// controller factories: createComposerAutocomplete / createAttachments /
// createComposerPaste / createPromptHistory / createQueueRecovery / createSend).
//
// The factory owns the inspect signal (the only reactive state) + the
// clipboard/fetch/revert operations. These are mostly pure fetch/clipboard ops;
// undo/redo are injected into createSend at the composition root (consumed
// lazily at send-time for "/undo" "/redo"), and retry closes over resendText
// from the send controller. Behavior-preserving extraction: bodies moved
// verbatim from ChatView, only `props.sessionId` → `deps.sessionId()`.

import { createSignal, type Accessor } from "solid-js";
import { markSessionIdle, openSession, setSelectedId, state } from "../../sync";
import { msgTextOnly, msgTextWithThinking } from "../../lib/msgText";
import { pushNotification } from "../../notify";

export interface MessageActionsDeps {
  // Session id for revert/unrevert/fork/abort/retry targets.
  sessionId: Accessor<string>;
  // retry() reuses sendText via the send controller's public resendText surface
  // (named so this factory doesn't reach into the private sendText). retry never
  // owns the composer, so it does NOT clear input — see createSend.sendText.
  resendText: (text: string, sessionId: string) => Promise<boolean>;
}

export interface MessageActions {
  copyMessage: (m: any) => void;
  copyMessageWithThinking: (m: any) => void;
  retry: (m: any) => void;
  inspectId: Accessor<string | null>;
  toggleInspect: (id: string) => void;
  inspectText: (m: any) => string;
  fork: (messageID: string) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  abort: () => Promise<void>;
}

export function createMessageActions(deps: MessageActionsDeps): MessageActions {
  // Copy / Retry text extraction lives in ../../lib/msgText (pure, unit-tested).
  // Retry uses msgTextOnly (thinking is never valid to re-send as a user
  // prompt). Copy has THREE coexisting paths: a tap (elapsed < HOLD_THRESHOLD_MS)
  // copies text-only (msgTextOnly); a long-press (elapsed >= HOLD_THRESHOLD_MS)
  // and a right-click both copy msgTextWithThinking (wraps each contiguous
  // reasoning run in <think>…</think>). The tap-vs-hold classifier is in
  // ../../lib/copyHold (classifyHold, pure, unit-tested) — the single threshold
  // source of truth shared with the paste button.
  const copyMessage = (m: any) => void navigator.clipboard?.writeText(msgTextOnly(m));
  const copyMessageWithThinking = (m: any) =>
    void navigator.clipboard?.writeText(msgTextWithThinking(m));
  const retry = (m: any) => void deps.resendText(msgTextOnly(m), deps.sessionId());

  // Inspect: tokens / cost / raw message JSON.
  const [inspectId, setInspectId] = createSignal<string | null>(null);
  const toggleInspect = (id: string) => setInspectId(inspectId() === id ? null : id);
  function inspectText(m: any): string {
    const i = m.info || {};
    const summary: any = {
      role: i.role,
      model: i.model ?? (i.providerID ? { providerID: i.providerID, modelID: i.modelID } : undefined),
      agent: i.agent,
      cost: i.cost,
      tokens: i.tokens,
      time: i.time,
    };
    return JSON.stringify({ summary, parts: m.partOrder.map((pid: string) => m.parts[pid]) }, null, 2);
  }

  // One-click fork from a turn — FE-bound guard (send-net-resilience slice 4c,
  // DEC-A8 "guard only"). Upstream fork is NOT idempotent and carries NO
  // caller-supplied id (research-packet-2 §A3: ForkPayload = {messageID} only;
  // a retry mints a full duplicate session "(fork #N)" with fresh message/part
  // ids — nothing links or removes the orphan). The /oc reverse proxy imposes
  // NO server-side bound on this POST (no total Transport timeout), so the FE
  // AbortController below is the ONLY bound. Three guards, and NOTHING else
  // changes about the success path:
  //   1. SINGLE-FLIGHT: one fork POST in flight per controller — a double-tap
  //      (or a second fork gesture while one runs) is a silent no-op, because
  //      each in-flight POST is one potentially-duplicating mutation.
  //   2. BOUND: FORK_TIMEOUT_MS (below) aborts a hung socket.
  //   3. HONEST OUTCOME-UNKNOWN: on timeout / network failure / 5xx / a 2xx
  //      whose body carries no session id, surface the outcome-unknown
  //      notification with the inspect-tree guidance. NEVER auto-retry — an
  //      automatic re-POST is exactly the duplicate-session machine this
  //      guard exists to prevent. A definitive non-2xx (4xx) is the one
  //      non-unknown class: the server answered and no fork was created.
  //
  // FORK_TIMEOUT_MS = 15s: fork is a session-CREATING action whose upstream
  // cost strictly exceeds a plain create (createNext + a durable per-message/
  // per-part copy of the whole prefix before messageID), so it sits one notch
  // above CREATE_SESSION_TIMEOUT_MS (12s) in the same bound family (replies
  // 10s / create 12s / fork 15s) instead of reusing the create bound. The
  // value is an ASSUMPTION pending weak-link baseline data (weaklink.ts) —
  // tune only against FE-vantage counters.
  const FORK_TIMEOUT_MS = 15_000;
  let forkInFlight = false;
  async function fork(messageID: string) {
    if (forkInFlight) return; // single-flight: no double-fire
    forkInFlight = true;
    const sessionID = deps.sessionId();
    // Mirrors replyOutcomeUnknown's honesty discipline (sync/actions.ts): the
    // POST may have been applied upstream, so this must NOT claim "failed",
    // and the guidance names the concrete duplicate risk.
    const outcomeUnknown = (detail: string) => {
      pushNotification({
        kind: "error",
        sessionID,
        title: "Fork outcome unknown",
        detail:
          "The fork was sent but no confirmation arrived — it may still have been created. " +
          "Inspect the session tree before retrying: a retry may create a duplicate session " +
          "that cannot be automatically cancelled." +
          (detail ? ` (${detail})` : ""),
      });
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FORK_TIMEOUT_MS);
    try {
      const res = await fetch(`/oc/session/${encodeURIComponent(sessionID)}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageID }),
        signal: ctrl.signal,
      });
      if (res.ok) {
        const s = await res.json().catch(() => null);
        if (s?.id) {
          // Success: the pre-guard behavior, unchanged.
          setSelectedId(s.id);
          void openSession(s.id);
          return;
        }
        // 2xx whose body has no session id: upstream likely applied the fork
        // but the answer is unusable — outcome unknown, not "not created".
        outcomeUnknown("response carried no session id");
        return;
      }
      // 5xx (incl. the proxy's transport-failure 502): the POST may have been
      // applied en route — outcome unknown. 4xx is a definitive server answer:
      // no fork exists, and the notice must not manufacture ambiguity.
      if (res.status >= 500) {
        outcomeUnknown(`HTTP ${res.status}`);
      } else {
        pushNotification({
          kind: "error",
          sessionID,
          title: "Fork not created",
          detail: `The server rejected the fork (HTTP ${res.status}); no fork was created.`,
        });
      }
    } catch (e) {
      // Network error or the FORK_TIMEOUT_MS abort — no response confirmed
      // either way: outcome unknown, never auto-retried here.
      const aborted = ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError");
      outcomeUnknown(aborted ? `no confirmation within ${FORK_TIMEOUT_MS / 1000}s` : `request failed (${String(e)})`);
    } finally {
      clearTimeout(timer);
      forkInFlight = false;
    }
  }

  // /undo and /redo map to revert / unrevert of the latest turn.
  async function undo() {
    const sm = state.messages[deps.sessionId()];
    const lastId = sm?.order[sm.order.length - 1];
    if (!lastId) return;
    await fetch(`/oc/session/${encodeURIComponent(deps.sessionId())}/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageID: lastId }),
    });
  }
  async function redo() {
    await fetch(`/oc/session/${encodeURIComponent(deps.sessionId())}/unrevert`, { method: "POST" });
  }

  async function abort() {
    // Clear the working indicator immediately — OpenCode doesn't reliably emit
    // an idle event on abort, so without this the spinner/shimmer would linger.
    markSessionIdle(deps.sessionId());
    // /vh/abort (not the /oc passthrough) also marks the session idle
    // authoritatively server-side, so a stream-reconnect snapshot can't re-arm
    // the working indicator on this stopped turn.
    await fetch("/vh/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: deps.sessionId() }),
    });
  }

  return { copyMessage, copyMessageWithThinking, retry, inspectId, toggleInspect, inspectText, fork, undo, redo, abort };
}
