import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
  useContext,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";
import Icon from "./Icon";

// Composition shell for the active pending-input surfaces (QuestionCard /
// PermissionCard). It is payload-agnostic: it only owns three things —
//
//   1. IN-STREAM PLACEMENT — its children render as the LAST item inside the
//      chat-stream content container (`.chat-content`), so the active blocker
//      reads as the tail of the transcript rather than a fixed bottom strip.
//   2. JUMP-PILL OBSERVER — an IntersectionObserver (root = the `.chat-scroll`
//      viewport) watches the wrapper. When the operator scrolls up and the
//      wrapper leaves the viewport entirely, ONE pill ("Answer needed" /
//      "Permission requested") is portaled into the positioned ancestor
//      (`.chat-main`) and re-glues the stream to the bottom on click. This
//      pill wins over the "↓ Latest" pill: ChatView suppresses "↓ Latest"
//      whenever a blocker is active, so the two never coexist.
//   3. POPUP-TRIGGER SLOT — children own their own popup-open state; this host
//      only provides the in-stream wrapper. The popup trigger button lives on
//      each card's chrome.
//   4. INTERACTION-SCOPED FOLLOW HOLD (Approach E) — while the operator is
//      actively interacting with the blocker (hover/press/focus/popup-open/
//      pinned reveal), the host aggregates that into a single `held()` memo
//      and reports it up to ChatView via `onHoldChange`. ChatView uses it to
//      suppress ONLY the programmatic content-resize re-glue-to-bottom write,
//      so the card stays at a stable viewport coordinate while streaming.
//      This is SEPARATE transient state from `following` / `userScrolledUp`;
//      the scroll classifier and composer-resize handling are untouched.
//
// The card components (QuestionCard / PermissionCard) are passed as children
// and plug in directly — no generic single-renderer abstraction over questions
// + permissions is imposed here.

// Child→host reporting surface. A child card calls these setters from its own
// createEffect to tell the host about state the host cannot observe via DOM
// pointer/focus events (because the popup is portaled OUTSIDE the wrapper
// subtree, and the pinned-reveal is an internal signal). The host folds these
// into `held()`. Optional chaining (hold?.set…) makes a standalone card render
// (no Provider above it) a no-op — unit tests that mount a card directly are
// unaffected.
export interface PendingInputHoldReport {
  // The card's portaled popup is open. Kept active so the hold survives the
  // focus transfer into the portal (focusout fires with relatedTarget=null,
  // which would otherwise release a focus-only hold mid-interaction).
  setPopupOpen: (open: boolean) => void;
  // The card has a persistent pinned reveal (e.g. PermissionCard's touch eye-
  // toggle pinning the "Always" grant-set open). Kept active independently of
  // hover so a touch-pinned reveal stays stable while streaming.
  setPinnedReveal: (pinned: boolean) => void;
}
const PendingInputHoldContext = createContext<PendingInputHoldReport>();
export { PendingInputHoldContext };
export function usePendingInputHold(): PendingInputHoldReport | undefined {
  return useContext(PendingInputHoldContext);
}

export default function PendingInput(props: {
  scrollRoot: () => HTMLElement | undefined;
  pillMount: () => HTMLElement | undefined;
  pillLabel: () => string;
  onJump: () => void;
  onHoldChange?: (held: boolean) => void;
  children: JSX.Element;
}) {
  let hostRef: HTMLDivElement | undefined;
  const [visible, setVisible] = createSignal(true);
  let io: IntersectionObserver | undefined;

  // --- Interaction-scoped follow hold (Approach E) -----------------------
  // Four orthogonal reasons the card should stay put while streaming. They are
  // OR'd into one `held()` memo so the hold survives ANY transition between
  // child controls (moving Allow once → Always → Reject, or hover → popup
  // open) without a transient release.
  const [pointerWithin, setPointerWithin] = createSignal(false);
  const [focusWithin, setFocusWithin] = createSignal(false);
  const [popupOpen, setPopupOpen] = createSignal(false);
  const [pinnedReveal, setPinnedReveal] = createSignal(false);
  const held = createMemo(
    () => pointerWithin() || focusWithin() || popupOpen() || pinnedReveal(),
  );
  // Report the aggregated hold up to ChatView. Reactive: re-runs whenever any
  // of the four inputs toggles.
  createEffect(() => props.onHoldChange?.(held()));
  // Defense against a stuck-hold bug (commit-review tier1_b/F1): the reporting
  // effect above is disposed when this component unmounts (e.g. the blocker is
  // answered), but it does NOT re-run on disposal, so it never emits a final
  // false. holdActive lives in the parent ChatView (OUTSIDE the <Show> that
  // mounts us), so it would stay true forever — silently breaking every
  // subsequent content-resize re-glue write. Release explicitly on cleanup so
  // the receiver always observes the unheld state when the card goes away.
  onCleanup(() => props.onHoldChange?.(false));

  // Stable report object (component body runs once in SolidJS) handed to the
  // context Provider so child cards can drive popupOpen / pinnedReveal.
  const report: PendingInputHoldReport = {
    setPopupOpen,
    setPinnedReveal,
  };

  // Focus aggregation: focusin/focusout bubble, so a single pair on the host
  // wrapper catches all descendants. focusout fires when focus moves to
  // another child (hostRef.contains(relatedTarget) → keep held) or out of the
  // card entirely (relatedTarget null or outside → release). Mirrors the
  // Tooltip.tsx pattern. Imperative add (not SolidJS onFocusOut) because
  // SolidJS delegates focus/blur as capture-phase focusin/focusout only when
  // `_$DX_DELEGATE` registers them; focusin/focusout are NOT in the default
  // delegation list, so declarative onFocusIn/onFocusOut would silently
  // no-op. See web/src/components/Tooltip.tsx for the same imperative setup.
  onMount(() => {
    if (!hostRef) return;
    const el = hostRef;
    const onFocusIn = () => setFocusWithin(true);
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null;
      if (next && el.contains(next)) return; // still inside the card
      setFocusWithin(false);
    };
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("focusout", onFocusOut);
    onCleanup(() => {
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("focusout", onFocusOut);
    });
  });

  // (Re)bind the observer whenever the scroll root changes. The wrapper sits at
  // the very bottom of the stream, so the pill is only wanted when it is FULLY
  // outside the viewport (the operator scrolled up to read history). Any pixel
  // intersecting → no pill.
  createEffect(() => {
    const root = props.scrollRoot();
    io?.disconnect();
    io = undefined;
    if (!root || !hostRef) return;
    io = new IntersectionObserver(
      (entries) => setVisible(entries[0]?.isIntersecting ?? true),
      { root, threshold: 0 },
    );
    io.observe(hostRef);
  });
  onCleanup(() => io?.disconnect());

  return (
    <>
      <div
        class="pending-input"
        ref={hostRef}
        // pointerenter/pointerleave do NOT fire when moving between descendants
        // (unlike pointerover/pointerout), so the hold survives child-to-child
        // transitions with a single declarative pair.
        onPointerEnter={() => setPointerWithin(true)}
        onPointerLeave={() => setPointerWithin(false)}
      >
        <PendingInputHoldContext.Provider value={report}>
          {props.children}
        </PendingInputHoldContext.Provider>
      </div>
      <Show when={!visible() && props.pillMount()}>
        <Portal mount={props.pillMount()!}>
          <button
            type="button"
            class="jump"
            onClick={() => props.onJump()}
            aria-label={props.pillLabel()}
          >
            <Icon name="arrowDown" size={14} /> {props.pillLabel()}
          </button>
        </Portal>
      </Show>
    </>
  );
}
