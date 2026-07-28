// Composer autocomplete controller (@file / @agent / /command suggestions).
//
// Extracted from ChatView.tsx (C3) so the suggestion state machine, keyboard
// navigation, stale-request guard, and caret-driven token detection can be
// exercised in isolation — mirroring the createQueueDrainer precedent: a
// SolidJS `create...` controller factory (NOT a React-style `use...` hook).
//
// The factory is constructed ONCE under the ChatView Solid owner. It takes
// Accessor<T> inputs + explicit setters + a DOM ref accessor, registers its
// effects + onCleanup inside that owner, and returns narrow visibility /
// selection accessors + stable action functions. The presentational popover
// JSX stays in ChatView (it needs the composer's geometry ref); this module
// owns ONLY the autocomplete behavior.
//
// What moved here (≈70 LOC, previously inlined in ChatView):
//   - activeToken() — the token under the caret that drives suggestions
//     (leading "/command", or an "@mention" with no whitespace to the caret)
//   - the suggestions createEffect — caret+input+session reactive recompute,
//     agent filter, async command/file fetch with a stale-request guard
//   - applyAc — splice the selected item into the composer at the token range
//   - keyboard navigation — ArrowUp/Down to move, Enter/Tab to apply, Escape
//     to dismiss (returned as onAcKeyDown which signals handled-vs-fallthrough
//     so ChatView's onKeyDown dispatcher preserves the autocomplete-first
//     precedence the prompt-history controller C5 will hook into later)
//
// What stays in ChatView: the onKeyDown dispatcher (calls onAcKeyDown FIRST,
// then send, then prompt-history), the textarea geometry/autosize, the popover
// JSX + acStyle() positioning (reads the composer rect).
import { type Accessor, createEffect, createSignal } from "solid-js";
import { type AcItem, commandSuggestions, fileSuggestions } from "../../lib/complete";
import type { AgentInfo } from "../../agents";

// Injectable inputs + side effects. ChatView passes its own signals/closures;
// tests pass fakes under createRoot. The textarea is an Accessor (not a captured
// ref) so the factory never holds a stale element across the reused component's
// session switches. `onApplied` is the C5 seam: prompt-history walk cursors
// (still inline in ChatView today) reset whenever an item is applied; kept as a
// callback so this module owns NO prompt-history state.
export interface ComposerAutocompleteDeps {
  // Current composer text + its setter.
  input: Accessor<string>;
  setInput: (v: string) => void;
  // Available agents — filtered into @mention candidates.
  agents: Accessor<AgentInfo[]>;
  // The composer textarea (may be undefined before mount / during reuse).
  textarea: Accessor<HTMLTextAreaElement | undefined>;
  // Session id — a reactive trigger so the controller recomputes suggestions
  // on a session switch even if the draft text happens to be identical.
  sessionId: Accessor<string>;
  // Draft mode suppresses /command suggestions (no server session to dispatch).
  draft: Accessor<boolean>;
  // C5 hook: reset prompt-history walk cursors after an item is applied.
  onApplied?: () => void;
}

// Narrow surface returned to ChatView. Visibility + selection are read-only
// accessors; actions are stable functions. `onAcKeyDown` returns true when it
// consumed the key (so the dispatcher falls through otherwise), preserving the
// autocomplete → send → history precedence.
export interface ComposerAutocomplete {
  // Filtered candidates currently shown.
  acItems: Accessor<AcItem[]>;
  // Selected (highlighted) index into acItems.
  acIndex: Accessor<number>;
  // Popover visibility: true iff there is at least one candidate.
  acVisible: Accessor<boolean>;
  // Set the highlighted index (popover onMouseEnter).
  setAcIndex: (i: number) => void;
  // Keyboard handler. Returns true if it handled the key (ArrowUp/Down to
  // navigate, Enter/Tab to apply, Escape to dismiss); false to fall through to
  // the send / prompt-history handlers. No-op (returns false) when closed.
  onAcKeyDown: (e: KeyboardEvent) => boolean;
  // Apply `item` (defaults to the currently-selected candidate) by splicing its
  // insert text over the active token, then focus + place the caret and fire
  // onApplied. No-op if there is no item or no active token.
  applyAc: (item?: AcItem) => void;
  // Close the popover (clear candidates).
  dismissAc: () => void;
  // Read the textarea caret into the internal caret signal. Wired to the
  // textarea's onClick/onKeyUp/onInput so token detection tracks the caret.
  syncCaret: () => void;
}

// The token under the caret that drives suggestions: a leading "/command", or
// an "@mention" with no whitespace between the @ and the caret.
interface ActiveToken {
  type: "command" | "mention";
  query: string;
  start: number;
  end: number;
}

export function createComposerAutocomplete(deps: ComposerAutocompleteDeps): ComposerAutocomplete {
  // Caret position drives activeToken(); it is internal to this controller
  // (only activeToken + applyAc + syncCaret read/write it). Externally the
  // textarea reports caret moves via syncCaret().
  const [caret, setCaret] = createSignal(0);
  const [acItems, setAcItems] = createSignal<AcItem[]>([]);
  const [acIndex, setAcIndex] = createSignal(0);
  // Race guard for async (file/command) fetches: each recompute bumps acReq and
  // only the most recent request's result is allowed to land — a slower earlier
  // fetch that resolves after a newer keystroke is dropped.
  let acReq = 0;

  function activeToken(): ActiveToken | null {
    const text = deps.input();
    const c = caret();
    if (text.startsWith("/")) {
      const sp = text.indexOf(" ");
      if (sp === -1 || c <= sp) return { type: "command", query: text.slice(1, c), start: 0, end: c };
    }
    const upto = text.slice(0, c);
    const at = upto.lastIndexOf("@");
    if (at >= 0 && !/\s/.test(upto.slice(at + 1))) {
      return { type: "mention", query: upto.slice(at + 1), start: at, end: c };
    }
    return null;
  }

  // Recompute suggestions whenever the input, caret, or session moves. Agents
  // are shown immediately for a mention; file matches merge in when they arrive
  // (guarded by acReq so a stale fetch can't overwrite a fresher list).
  createEffect(() => {
    deps.input();
    caret();
    deps.sessionId(); // recompute on session switch too (draft restore changes
                      // input, but listing the sid keeps the controller
                      // self-contained even if the text is identical)
    const tok = activeToken();
    if (!tok || (deps.draft() && tok.type === "command")) {
      setAcItems([]);
      return;
    }
    const req = ++acReq;
    setAcIndex(0);
    if (tok.type === "command") {
      void commandSuggestions(tok.query).then((items) => req === acReq && setAcItems(items));
    } else {
      const q = tok.query.toLowerCase();
      const agentItems: AcItem[] = deps
        .agents()
        .filter((a) => a.name.toLowerCase().includes(q))
        .slice(0, 5)
        .map((a) => ({ kind: "agent", label: "@" + a.name, detail: a.description, insert: "@" + a.name + " " }));
      // Show agents immediately; merge in file matches when they arrive.
      setAcItems(agentItems);
      if (tok.query.length >= 1) {
        void fileSuggestions(tok.query).then((files) => req === acReq && setAcItems([...agentItems, ...files]));
      }
    }
  });

  function applyAc(item?: AcItem) {
    const it = item ?? acItems()[acIndex()];
    if (!it) return;
    const tok = activeToken();
    if (!tok) return;
    const text = deps.input();
    const before = text.slice(0, tok.start);
    const after = text.slice(tok.end);
    deps.setInput(before + it.insert + after);
    const pos = (before + it.insert).length;
    setAcItems([]);
    deps.onApplied?.();
    queueMicrotask(() => {
      const ta = deps.textarea();
      if (ta) {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = pos;
        setCaret(pos);
      }
    });
  }

  function dismissAc() {
    setAcItems([]);
  }

  function onAcKeyDown(e: KeyboardEvent): boolean {
    if (!acItems().length) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setAcIndex((i) => Math.min(i + 1, acItems().length - 1));
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setAcIndex((i) => Math.max(i - 1, 0));
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      applyAc();
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      dismissAc();
      return true;
    }
    return false;
  }

  function syncCaret() {
    const ta = deps.textarea();
    if (ta) setCaret(ta.selectionStart ?? 0);
  }

  return {
    acItems,
    acIndex,
    acVisible: () => acItems().length > 0,
    setAcIndex,
    onAcKeyDown,
    applyAc,
    dismissAc,
    syncCaret,
  };
}
