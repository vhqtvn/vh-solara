import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { projectDir } from "../sync";
import { bindCodeFrame } from "../codeFrame";

// Hosts the code viewer in a same-origin iframe so its DOM stays isolated from
// the main document. Lazily mounted on first use and then kept alive (hidden
// when inactive) so the open file + scroll position survive tab switches. The
// src carries the project dir, so switching projects reloads it.
export default function CodeFrame(props: { active: () => boolean }) {
  const [mounted, setMounted] = createSignal(false);
  createEffect(() => {
    if (props.active()) setMounted(true);
  });
  let el: HTMLIFrameElement | undefined;
  const src = createMemo(() => `${location.pathname}?standalone=code&dir=${encodeURIComponent(projectDir())}`);
  return (
    <Show when={mounted()}>
      <iframe
        ref={el}
        class="code-frame"
        classList={{ hidden: !props.active() }}
        title="Code"
        src={src()}
        onLoad={() => bindCodeFrame(el!)}
      />
    </Show>
  );
}
