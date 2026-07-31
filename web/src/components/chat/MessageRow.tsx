// MessageRow — extracted from ChatView.tsx (the ~150-LOC `<For>` row callback
// at the former ~1588-1739).
//
// Renders ONE message row: the `.msg[data-mid]` wrapper element, its head
// (role / agent / model / time / cost / perf badges + copy/inspect/fork/retry
// actions), the deferred `<MessageParts>` body, and the inline error/inspect
// panels. Extracted behavior-preserving — no wrapper, no cloning, no keyed
// remount.
//
// HARD INVARIANTS (pinned by web/tests/unit/ChatView{CopyGestureEdge,
// MessageRowIdentity,DeferredRow}.test.tsx via the mounted ChatView):
//   - Returns the `.msg[data-mid]` element DIRECTLY — NO wrapper div, NO
//     fragment, NO keyed wrapper. `<For>` (still in ChatView) inserts this
//     element as a direct child of `.chat-content`; scroll/read/nav logic and
//     the row-DOM-identity tests rely on that parent->child contract.
//   - The message object passes BY REFERENCE and is read LIVE (`props.message`
//     is a reactive proxy; never destructured/snapshotted). Updates that keep
//     `byId[id]` referentially stable must NOT remount the row.
//   - The per-row copy-hold `let`s below are initialized ONCE per MessageRow
//     instance (the component function runs once per row at mount, mirroring
//     the former `<For>` closure) — see the SolidJS no-rerender note.
//   - Deferred's IntersectionObserver is the ONLY observer here, rooted at
//     `props.scrollRoot` (the scrollEl forwarded from ChatView).
import { type Accessor, Show, createMemo } from "solid-js";
import type { MessageView } from "../../types";
import { MessageParts } from "./MessageParts";
import { Deferred } from "../Deferred";
import Icon from "../Icon";
import RelTime from "../RelTime";
import { agentLabel, costLabel, messageError, modelLabel, roleLabel } from "./messageMeta";
import { classifyHold, shouldSkipAfterContextmenu } from "../../lib/copyHold";
import { fmtTurnStats, turnStats } from "../../usage";

// Eager-mount the last N message rows (the tail you see on open + where new
// messages and the live stream land), so scroll-to-bottom and streaming stay
// correct; older rows mount lazily as they near the viewport (see Deferred).
const EAGER_TAIL = 30;

export interface MessageRowProps {
  // The current message/store object (live, not snapshot) — read reactively.
  message: MessageView;
  // Reactive `<For>` index accessor.
  index: Accessor<number>;
  // messages().length — drives the eager-tail threshold + isLastMessage.
  messageCount: Accessor<number>;
  // scrollEl for the Deferred IntersectionObserver root.
  scrollRoot: Accessor<HTMLElement | undefined>;
  lastActivityKey: Accessor<string | null>;
  messageFailed: Accessor<boolean>;
  // inspectId() === message.id (computed in ChatView).
  inspected: Accessor<boolean>;
  // Each callback closes over the current message in ChatView
  // (e.g. onFork={() => fork(m.id)}); MessageRow invokes them verbatim.
  onToggleInspect: () => void;
  onCopyText: () => void;
  onCopyWithThinking: () => void;
  onFork: () => void;
  onRetry: () => void;
  inspectText: () => string;
}

// The agent label in a message head — plain @name. The COLORED per-agent badge
// (agentStyles) lives on the session-list rows, not here (deliberately keeping
// the transcript quiet).
function MsgAgent(props: { info: any }) {
  const name = () => agentLabel(props.info);
  return (
    <Show when={name()}>
      <span class="msg-agent" data-tip={`Agent: ${name()}`}>@{name()}</span>
    </Show>
  );
}

// Per-turn performance (tok/s · TTFT) for a SETTLED assistant turn, behind a
// hover ⓘ icon so the footer stays clean. Memoized — turnStats only walks parts
// for a completed assistant message (gated at the call site on role+completed),
// so it never runs for in-flight turns and never touches the streaming hot loop.
// The hover surface is a plain delegated `data-tip` tooltip (static text), so it
// is cheap to render and free of the GPU-punishing patterns called out for the
// chat surface.
function MsgPerf(props: { m: MessageView }) {
  const tip = createMemo(() => {
    const s = turnStats(props.m);
    return s ? fmtTurnStats(s) : "";
  });
  return (
    <Show when={tip()}>
      <span class="msg-perf" data-tip={tip()} tabindex="0" aria-label="Turn performance">
        <Icon name="info" size={12} />
      </span>
    </Show>
  );
}

export function MessageRow(props: MessageRowProps) {
  // Per-message hold state for the Copy button: a long-press
  // (>=HOLD_THRESHOLD_MS) copies thinking, a tap copies text-only,
  // right-click copies thinking. State is per-row (captured in this
  // MessageRow instance) so two messages' gestures can't race a shared
  // timestamp; only one button is pressed at a time anyway.
  // thinkingJustCopied dedupes the Android-Chrome touch
  // double-fire (contextmenu then a synthesized click) — see
  // shouldSkipAfterContextmenu in ../../lib/copyHold.
  //
  // SolidJS no-rerender note (same as the paste button): SolidJS
  // is NOT React — the MessageRow component function runs ONCE per row at
  // mount, so these `let`s persist for the row's lifetime (the instance
  // survives session switches via the non-keyed
  // <Show when={selectedId()}> at App.tsx:367). Without an explicit
  // reset, a single pointer gesture (copyDownAt set to a real
  // timestamp T) would leave the closure stale, and a LATER
  // keyboard activation of the same focused Copy button would
  // classify as "hold" → wrong branch (thinking-or-skip instead of
  // text-only). We close this edge two ways: (1) onBlur resets
  // copyDownAt (and thinkingJustCopied, defensively) to their
  // initial values when focus leaves the button (focus leaving =
  // gesture context ended; pointer→click→blur ordering means the
  // click already ran with the correct timestamp, so blur-side
  // reset does not break pointer-hold detection); and (2) the
  // click handler resets copyDownAt to 0 AFTER classifyHold
  // consumed it, closing the narrow residual "pointer-press then
  // immediate Enter on the same focused button without focus
  // moving away" hole. Note: when copyDownAt===0, classifyHold
  // returns "tap", and shouldSkipAfterContextmenu is short-circuited
  // because it requires cls==="hold" — so a lingering stale
  // thinkingJustCopied=true cannot suppress a keyboard tap;
  // resetting it anyway is harmless and keeps state clean.
  let copyDownAt = 0;
  let thinkingJustCopied = false;
  return (
    <div class="msg" data-mid={props.message.id} classList={{ user: props.message.info.role === "user", assistant: props.message.info.role === "assistant" }}>
      <div class="msg-head">
        <span class="msg-role">{roleLabel(props.message.info.role)}</span>
        <MsgAgent info={props.message.info} />
        <Show when={modelLabel(props.message.info)}>
          <span class="msg-model" data-tip={modelLabel(props.message.info)}>{modelLabel(props.message.info)}</span>
        </Show>
        <RelTime class="msg-time" mode="ago" ms={props.message.info.time?.created} />
        <Show when={costLabel(props.message.info)}>
          <span class="msg-cost">{costLabel(props.message.info)}</span>
        </Show>
        <Show when={props.message.info.role === "assistant" && props.message.info.time?.completed}>
          <MsgPerf m={props.message} />
        </Show>
        <div class="msg-actions">
          <button
            type="button"
            class="msg-copy"
            data-tip="Copy · hold or right-click for thinking"
            aria-label="Copy message text; hold or right-click to include reasoning"
            onPointerDown={() => {
              // Fresh gesture: record the press time (mouse-hold and
              // touch-hold unified via Pointer Events, same reasoning
              // as the paste button) and clear the contextmenu-dedupe
              // flag for a new cycle.
              copyDownAt = Date.now();
              thinkingJustCopied = false;
            }}
            onClick={() => {
              const cls = classifyHold(copyDownAt, Date.now());
              // Reset AFTER classifyHold consumed the value — closes
              // the narrow residual "pointer-press then immediate
              // Enter on the same focused button without focus
              // moving away" hole (see the SolidJS no-rerender note
              // above). Safe because classifyHold already read the
              // value; the next pointerdown of a fresh gesture will
              // set it again.
              copyDownAt = 0;
              if (cls === "hold") {
                // Android-Chrome touch long-press synthesizes a click
                // AFTER the contextmenu that already copied thinking;
                // skip the duplicate. Mouse-hold and iOS (no touch
                // contextmenu) copy thinking here.
                if (shouldSkipAfterContextmenu(thinkingJustCopied, cls)) {
                  thinkingJustCopied = false;
                  return;
                }
                props.onCopyWithThinking();
              } else {
                props.onCopyText();
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              // Flag that thinking was already copied so the
              // synthesized click in the same touch long-press
              // gesture is deduped (deterministic: contextmenu is
              // guaranteed to precede the click).
              thinkingJustCopied = true;
              props.onCopyWithThinking();
            }}
            onBlur={() => {
              // Focus leaving the button = gesture context ended.
              // Return the per-row closure to its initial state so
              // the NEXT keyboard activation (Enter/Space on this
              // focused Copy button) classifies as "tap" (text-only)
              // instead of misclassifying from a stale pointer
              // timestamp. See the SolidJS no-rerender note above
              // the per-row classifier. Resetting copyDownAt alone
              // is sufficient for keyboard parity (a downAt===0
              // classifyHold result is "tap", which bypasses
              // shouldSkipAfterContextmenu entirely); we reset
              // thinkingJustCopied too for cleanliness/symmetry.
              copyDownAt = 0;
              thinkingJustCopied = false;
            }}
          >
            <Icon name="copy" size={14} />
          </button>
          <button type="button" data-tip="Inspect" aria-label="Inspect" onClick={() => props.onToggleInspect()}>
            <Icon name="info" size={14} />
          </button>
          <button type="button" data-tip="Fork from here" aria-label="Fork" onClick={() => props.onFork()}>
            <Icon name="fork" size={14} />
          </button>
          <Show when={props.message.info.role === "user"}>
            <button type="button" data-tip="Retry" aria-label="Retry" onClick={() => props.onRetry()}>
              <Icon name="retry" size={14} />
            </button>
          </Show>
        </div>
      </div>
      <Deferred
        class="msg-parts"
        eager={props.index() >= props.messageCount() - EAGER_TAIL}
        root={props.scrollRoot}
        minHeight={48}
      >
        <MessageParts
          m={props.message}
          isLastMessage={() => props.index() === props.messageCount() - 1}
          lastActivityKey={props.lastActivityKey}
          failed={props.messageFailed}
        />
      </Deferred>
      <Show when={messageError(props.message.info)}>
        <div class="msg-error">⚠ {messageError(props.message.info)}</div>
      </Show>
      <Show when={props.inspected()}>
        <pre class="msg-inspect">{props.inspectText()}</pre>
      </Show>
    </div>
  );
}
