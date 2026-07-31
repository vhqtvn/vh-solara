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

  // One-click fork from a turn.
  async function fork(messageID: string) {
    const res = await fetch(`/oc/session/${encodeURIComponent(deps.sessionId())}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageID }),
    });
    const s = await res.json().catch(() => null);
    if (s?.id) {
      setSelectedId(s.id);
      void openSession(s.id);
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
