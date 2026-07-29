// Composer paste/clipboard controller — the textarea ClipboardEvent + the
// paste button's async Clipboard-API read.
//
// Extracted from ChatView.tsx (C4) so the paste/clipboard concern can be
// exercised in isolation, mirroring the createComposerAutocomplete (C3) and
// createPromptHistory (C5) precedent: a SolidJS `create...` controller factory
// (NOT a React-style `use...` hook).
//
// The factory is constructed ONCE under the ChatView Solid owner. It takes
// Accessor<T> inputs + explicit setters + a DOM ref accessor + a caret-sync seam
// (from C3) and an optional attachment hook, and returns stable handlers. The
// factory owns NO reactive state of its own (the tap/hold press-state is a plain
// closure var — nothing subscribes to it, so a signal would be dead weight), and
// registers no effects/cleanup; its only entry points are the returned handlers.
//
// What moved here (~104 LOC, previously inlined in ChatView):
//   - onPaste — the textarea ClipboardEvent: harvest pasted files/images →
//     addFiles (preventDefault); plain-text paste falls through to the browser
//     default (which fires onInput, so prompt-history resets naturally).
//   - pasteFromClipboard — the paste button's async Clipboard-API read + text
//     insert-at-caret ("insert") / replace-all ("replace"), with caret handling
//     + syncCaret.
//   - paste-button tap-vs-hold classification (classifyHold from lib/copyHold,
//     shared threshold + load-independent rationale) + the pointer/blur handlers
//     that record/reset the press-state closure.
//
// What stays in ChatView: the addFiles IMPLEMENTATION (attachment rendering +
// geometry stays), textarea autosize / composer geometry / scroll surface, the
// shared onKeyDown dispatcher (paste is a separate event, not a key), and the
// copy-message buttons' OWN classifyHold usage (classifyHold is a shared lib
// function; the copy buttons keep their own copyDownAt closure in ChatView).
import { type Accessor } from "solid-js";
import { harvestPastedFiles } from "../../lib/paste";
import { classifyHold } from "../../lib/copyHold";

// Injectable inputs + side effects. ChatView passes its own signals/closures;
// tests pass fakes under createRoot. The textarea is an Accessor (not a captured
// ref) so the factory never holds a stale element across the reused component's
// session switches.
export interface ComposerPasteDeps {
  // Current composer text + its setter.
  input: Accessor<string>;
  setInput: (v: string) => void;
  // The composer textarea (may be undefined before mount / during reuse).
  textarea: Accessor<HTMLTextAreaElement | undefined>;
  // Read the textarea caret into the C3 autocomplete controller. Called after a
  // clipboard-API text insert (pasteFromClipboard) so token detection tracks the
  // new caret — the textarea onPaste path needs no syncCaret (file paste →
  // addFiles; plain-text paste falls through to the browser default).
  syncCaret: () => void;
  // Attachment pipeline hook: a textarea paste of files/images harvests them and
  // hands them here. Optional — when unset a file paste still preventDefault's
  // (so the browser default image-paste doesn't run) but the files are dropped.
  addFiles?: (files: File[]) => void;
  // Reset prompt-history walk cursors after a clipboard-API text insert. The
  // paste button bypasses the textarea, so the natural onInput that would reset
  // history never fires; this seam restores it. Optional.
  onTextInsert?: () => void;
}

// Narrow surface returned to ChatView. All handlers are stable for the ChatView
// instance lifetime (the tap/hold press-state is a closure var, not a signal).
export interface ComposerPaste {
  // Textarea ClipboardEvent handler. Harvests pasted files/images → addFiles and
  // preventDefault's; plain-text paste falls through to the browser default.
  onPaste: (e: ClipboardEvent) => void;
  // Paste button: read the async Clipboard API and insert at the caret
  // ("insert", long-press) or replace the whole composer ("replace", plain tap).
  // Silently no-ops on permission denial / unsupported / empty clipboard.
  pasteFromClipboard: (mode: "replace" | "insert") => Promise<void>;
  // Paste-button pointer/click handlers (classifyHold tap-vs-hold from copyHold).
  onPasteButtonDown: () => void;
  onPasteButtonUp: () => void;
  onPasteButtonClick: () => void;
  // Reset the press-state closure when focus leaves the button (SolidJS
  // no-rerender: the closure persists for the instance lifetime; without this a
  // later keyboard activation of the focused button would misclassify from a
  // stale pointer timestamp).
  onPasteButtonBlur: () => void;
}

export function createComposerPaste(deps: ComposerPasteDeps): ComposerPaste {
  // Paste clipboard text into the composer. For mobile / no-physical-keyboard
  // where ⌘/Ctrl+V isn't handy; image/file paste still goes through the
  // textarea's onPaste. Reads via the async Clipboard API (needs a user gesture
  // + permission — the tap/hold is the gesture); silently no-ops if
  // denied/unsupported.
  //   - "replace": overwrite the whole composer (the plain tap)
  //   - "insert":  insert at the caret, replacing any selection (long-press)
  async function pasteFromClipboard(mode: "replace" | "insert") {
    let text = "";
    try {
      text = (await navigator.clipboard?.readText()) ?? "";
    } catch {
      deps.textarea()?.focus(); // permission denied / unsupported — leave the field focused so ⌘V works
      return;
    }
    if (!text) {
      deps.textarea()?.focus();
      return;
    }
    let pos: number;
    if (mode === "replace") {
      deps.setInput(text);
      pos = text.length;
    } else {
      const cur = deps.input();
      const ta = deps.textarea();
      const start = ta?.selectionStart ?? cur.length;
      const end = ta?.selectionEnd ?? cur.length;
      const before = cur.slice(0, start);
      deps.setInput(before + text + cur.slice(end));
      pos = before.length + text.length;
    }
    deps.onTextInsert?.();
    queueMicrotask(() => {
      const ta = deps.textarea();
      if (ta) {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = pos;
        deps.syncCaret();
      }
    });
  }

  // Tap vs hold on the paste button: a plain tap replaces the whole composer; a
  // long-press (>=HOLD_THRESHOLD_MS between pointerdown and click) inserts at
  // the caret. Classification goes through the shared classifyHold helper
  // (../lib/copyHold, same one the Copy button uses), so the two hold
  // affordances share one threshold and one load-independent rationale: a
  // previous timer+flag scheme misclassified as "replace" when main-thread jank
  // stalled the event loop past the threshold (CI load, throttled devices),
  // because the timer callback raced the click handler. classifyHold also
  // returns "tap" for keyboard activation (Enter/Space on the focused button
  // fires click with no preceding pointerdown → pasteDownAt stays 0 → the
  // downAt===0 sentinel), giving keyboard users the documented "replaces all"
  // default instead of the hold branch. The insert runs in the click handler,
  // which is still inside the transient-activation window opened by pointerdown
  // (lasts several seconds), so clipboard read works.
  //
  // SolidJS no-rerender note: SolidJS is NOT React — component bodies and JSX
  // run once at mount, so this `let pasteDownAt` closure persists for the whole
  // ChatView instance lifetime (it even survives session switches via the
  // non-keyed <Show when={selectedId()}> at App.tsx:367). Without an explicit
  // reset, a single pointer gesture (downAt set to a real timestamp T) would
  // leave the closure stale, and a LATER keyboard activation of the same
  // focused button would classify as "hold" (T is old → elapsed >= threshold)
  // → wrong branch. We close this edge two ways: (1) onBlur resets pasteDownAt
  // to 0 when focus leaves the button (focus leaving = gesture context ended;
  // pointer→click→blur ordering means the click already ran with the correct
  // timestamp, so blur-side reset does not break pointer-hold detection); and
  // (2) the click handler resets pasteDownAt to 0 AFTER classifyHold consumed
  // it, closing the narrow residual "pointer-press then immediate Enter on the
  // same focused button without focus moving away" hole. Both resets return
  // the closure to the downAt===0 sentinel so the next activation (pointer or
  // keyboard) starts clean.
  let pasteDownAt = 0;
  function onPasteButtonDown() {
    pasteDownAt = Date.now();
  }
  function onPasteButtonUp() {} // no-op; elapsed check on click makes hold load-independent
  function onPasteButtonClick() {
    if (classifyHold(pasteDownAt, Date.now()) === "hold") {
      pasteDownAt = 0; // reset AFTER classifyHold consumed it — closes the
                       // "pointer then immediate Enter on the same focused
                       // button" residual (see comment above).
      void pasteFromClipboard("insert");
      return;
    }
    pasteDownAt = 0; // same reset on the tap branch.
    void pasteFromClipboard("replace");
  }
  function onPasteButtonBlur() {
    // Focus leaving the button = gesture context ended. Return the closure to
    // the downAt===0 sentinel so the NEXT keyboard activation (Enter/Space on
    // this focused button) classifies as "tap" (documented "replaces all"
    // default) instead of misclassifying from a stale pointer timestamp. See
    // the SolidJS no-rerender note above the paste classifier.
    pasteDownAt = 0;
  }

  function onPaste(e: ClipboardEvent) {
    // Paste an image/file (e.g. a screenshot) straight into the composer as an
    // attachment; plain-text paste falls through. Many browsers expose pasted
    // files ONLY via clipboardData.items (getAsFile) while .files stays empty,
    // so harvest both and prefer items (see lib/paste.ts).
    const cd = e.clipboardData;
    const harvested = harvestPastedFiles(
      cd?.files ? Array.from(cd.files) : null,
      cd?.items ? Array.from(cd.items) : null,
    );
    if (harvested.length > 0) {
      e.preventDefault();
      deps.addFiles?.(harvested);
    }
  }

  return {
    onPaste,
    pasteFromClipboard,
    onPasteButtonDown,
    onPasteButtonUp,
    onPasteButtonClick,
    onPasteButtonBlur,
  };
}
