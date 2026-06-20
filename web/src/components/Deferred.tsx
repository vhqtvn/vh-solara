import { type Accessor, type JSX, type ParentProps, Show, createSignal, onCleanup, onMount } from "solid-js";

// Deferred mounts its (expensive) children only once the element is near the
// viewport — occlusion-based virtualization for the message list. The transcript
// is NOT windowed (all rows exist), but a row's heavy content (markdown render,
// mermaid, server fetch) is created lazily, so opening a session with thousands
// of messages doesn't mount thousands of renderers up front.
//
// `eager` forces immediate mount (used for the tail so scroll-to-bottom and the
// live/streaming message are always real). Once mounted it NEVER unmounts — that
// avoids re-fetch/re-render churn and scroll jumps; the cost is paid once, lazily.
// While pending, `minHeight` reserves space so the scrollbar isn't wildly off
// (browser scroll-anchoring absorbs the rest when off-screen rows fill in).
export function Deferred(
  props: ParentProps<{
    class?: string;
    eager?: boolean;
    root?: Accessor<HTMLElement | undefined>;
    minHeight?: number;
  }>,
): JSX.Element {
  const [show, setShow] = createSignal(!!props.eager);
  let el: HTMLDivElement | undefined;
  onMount(() => {
    if (show()) return; // eager: already mounted, no observer needed
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShow(true);
          io.disconnect();
        }
      },
      { root: props.root?.() ?? null, rootMargin: "1200px 0px" },
    );
    if (el) io.observe(el);
    onCleanup(() => io.disconnect());
  });
  return (
    <div ref={el} class={props.class} style={!show() && props.minHeight ? { "min-height": `${props.minHeight}px` } : undefined}>
      <Show when={show()}>{props.children}</Show>
    </div>
  );
}
