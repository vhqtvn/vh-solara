import {
  createEffect,
  createSignal,
  onCleanup,
  Show,
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
//
// The card components (QuestionCard / PermissionCard) are passed as children
// and plug in directly — no generic single-renderer abstraction over questions
// + permissions is imposed here.
export default function PendingInput(props: {
  scrollRoot: () => HTMLElement | undefined;
  pillMount: () => HTMLElement | undefined;
  pillLabel: () => string;
  onJump: () => void;
  children: JSX.Element;
}) {
  let hostRef: HTMLDivElement | undefined;
  const [visible, setVisible] = createSignal(true);
  let io: IntersectionObserver | undefined;

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
      <div class="pending-input" ref={hostRef}>
        {props.children}
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
