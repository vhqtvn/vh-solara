// Prompt-history recall controller for the composer — shell-style Up / Ctrl+Up
// walk through sent prompts. Extracted from ChatView.tsx (C5) so the recall
// state machine + keyboard handler can be exercised in isolation, mirroring
// the createComposerAutocomplete (C3) and createQueueDrainer precedent: a
// SolidJS `create...` controller factory (NOT a React-style `use...` hook).
//
// The factory is constructed ONCE under the ChatView Solid owner. It takes
// Accessor<T> inputs + an explicit setter + a DOM ref accessor and returns a
// stable keyboard handler + a reset seam. The factory owns NO reactive state of
// its own (the walk cursors are plain closure vars — nothing subscribes to
// them, so signals would be dead weight), and registers no effects/cleanup;
// its only entry points are the two returned functions. ChatView keeps the
// shared onKeyDown dispatcher (autocomplete → send → history precedence).
//
// What moved here (~50 LOC, previously inlined in ChatView):
//   - histMode / histIdx / histDraft walk state
//   - onHistoryKey — Up / Ctrl+Up walk back, Down step forward
//   - live-draft capture (exactly once per walk) + restoration on Down-past-zero
//   - resetHistory — return to the live draft (bottom of the stack)
//
// Two recall scopes share one cursor:
//   - histMode "session" = plain Up, reads the per-session store (prompts sent
//     in THIS session; a fresh draft recalls the "__new__" store).
//   - histMode "global"  = Ctrl/Cmd+Up, reads the global store (any session,
//     including legacy pre-split data).
//   - "none" = editing the live draft. histIdx -1 = live draft; >=0 = recalled
//     entry. histDraft is the live-input snapshot captured on the first step
//     of a walk, restored when Down steps past zero. Switching scopes
//     (Up↔Ctrl+Up) starts a fresh walk so the two stores never share an index.
//
// What stays in ChatView: the shared onKeyDown dispatcher (calls
// ac.onAcKeyDown FIRST, then send, then hist.onHistoryKey LAST), pushHistory
// (the store write at send time), and every resetHistory call site (onApplied,
// onInput, paste, inline attach, session switch, send).
import { type Accessor } from "solid-js";
import { historyAt, historyLen } from "../../history";

// Injectable inputs + side effects. ChatView passes its own signals/closures;
// tests pass fakes under createRoot. The textarea is an Accessor (not a captured
// ref) so the factory never holds a stale element across the reused component's
// session switches.
export interface PromptHistoryDeps {
  // Current composer text + its setter.
  input: Accessor<string>;
  setInput: (v: string) => void;
  // The composer textarea (may be undefined before mount / during reuse). Read
  // for the caret-start gate on plain Up, and to reset the caret to 0 on a
  // recall so a re-walk starts at the top.
  textarea: Accessor<HTMLTextAreaElement | undefined>;
  // Session id — "session" scope recalls this session's store; "" / draft
  // normalizes to "__new__" (matching the draft-key convention).
  sessionId: Accessor<string>;
}

// Narrow surface returned to ChatView. Both functions are stable for the
// ChatView instance lifetime. `onHistoryKey` returns true when it consumed the
// key (recalled / stepped + preventDefault'd); false to signal "not a history
// key / nothing to recall" — informational only, since history is the LAST entry
// in the shared dispatcher (nothing falls through after it).
export interface PromptHistory {
  // Keyboard handler. Returns true if it consumed the key (ArrowUp walk-back
  // that actually recalled, or ArrowDown step while walking); false otherwise.
  // MUST be called AFTER ac.onAcKeyDown so autocomplete owns its keys first —
  // preserving the autocomplete → send → history precedence.
  onHistoryKey: (e: KeyboardEvent) => boolean;
  // Reset to the live draft (bottom of the stack): abandons any in-flight walk.
  // Called by every site that invalidates the walk: the C3 onApplied seam,
  // onInput, paste, inline-attach insertion, session switch, and send.
  resetHistory: () => void;
}

export function createPromptHistory(deps: PromptHistoryDeps): PromptHistory {
  // Walk cursors — plain closure vars (no reactive subscriber, so signals would
  // be dead weight). histIdx -1 = live draft; >=0 = recalled entry. histDraft
  // is the live-input snapshot captured on the FIRST step of a walk, restored
  // when Down steps past zero. Switching scopes resets the index but must NOT
  // overwrite histDraft (see the wasIdle guard below).
  let histMode: "none" | "session" | "global" = "none";
  let histIdx = -1;
  let histDraft = "";

  // Session id normalized to the per-session store key (draft "" → "__new__").
  const histSid = () => deps.sessionId() || "__new__";

  function resetHistory() {
    histMode = "none";
    histIdx = -1;
  }

  function onHistoryKey(e: KeyboardEvent): boolean {
    const ta = deps.textarea();
    // Plain Up requires the caret at the very start (so multi-line editing
    // isn't hijacked); Ctrl/Cmd+Up skips that gate and walks the GLOBAL store.
    const ctrl = e.ctrlKey || e.metaKey;
    const sid = histSid();
    if (e.key === "ArrowUp" && ta && (ctrl || (ta.selectionStart === 0 && ta.selectionEnd === 0))) {
      const mode: "session" | "global" = ctrl ? "global" : "session";
      const len = mode === "global" ? historyLen() : historyLen(sid);
      if (len > 0) {
        // Capture the live draft exactly once — when starting a walk from the
        // idle state. Switching scopes mid-walk (Up↔Ctrl+Up) resets the index
        // but must NOT overwrite the captured draft with a recalled value, or
        // Down-past-zero would restore the wrong text.
        const wasIdle = histMode === "none";
        if (histMode !== mode) {
          histMode = mode;
          histIdx = -1;
        }
        const next = Math.min(histIdx + 1, len - 1);
        const v = mode === "global" ? historyAt(next) : historyAt(next, sid);
        if (v !== undefined) {
          e.preventDefault();
          if (wasIdle && histIdx === -1) histDraft = deps.input();
          histIdx = next;
          deps.setInput(v);
          queueMicrotask(() => ta && (ta.selectionStart = ta.selectionEnd = 0));
          return true;
        }
      }
      // Matched the ArrowUp-recall gate but the store was empty / entry absent:
      // no recall happened, so let the browser default run (return false).
      return false;
    }
    if (e.key === "ArrowDown" && histMode !== "none" && histIdx >= 0) {
      e.preventDefault();
      histIdx -= 1;
      if (histIdx < 0) {
        histMode = "none";
        deps.setInput(histDraft);
      } else {
        deps.setInput(histMode === "global" ? historyAt(histIdx) ?? "" : historyAt(histIdx, sid) ?? "");
      }
      return true;
    }
    return false;
  }

  return { onHistoryKey, resetHistory };
}
