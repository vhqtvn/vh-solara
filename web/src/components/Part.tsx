import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { createStore } from "solid-js/store";
import { renderMarkdown } from "../render";
import { renderStreamMd } from "../lib/md";
import { StreamMd } from "../lib/streamMd";
import { placeStreamCaret } from "../lib/streamCaret";
import { renderMathIn } from "../lib/math";
import { streamLive } from "../prefs";
import { openFileAt } from "../code/frame";
import { looksLikePath } from "../lib/pathlike";
import { addCodeCopyButtons, linkifyPaths, splitMermaid, tagInlineCodePaths } from "../lib/markdownEnhance";
import type { Part } from "../types";
import Icon from "./Icon";
import { ToolPart } from "./ToolPart";
import MermaidViewer from "./MermaidViewer";
import styles from "./Part.module.css";

// Per-part expand state, keyed by part id and held OUTSIDE the components.
// The chat re-groups parts into fresh arrays as a turn streams, which re-creates
// the row components — local open signals would reset on every new token (a
// manually-expanded Thinking/tool would snap shut). Keying by id here makes the
// toggle survive that churn.
export const [partOpen, setPartOpenStore] = createStore<Record<string, boolean>>({});
export const setPartOpen = (id: string, v: boolean) => setPartOpenStore(id, v);

// One prose segment: daemon-rendered, syntax-highlighted HTML with copy buttons
// and clickable file paths.
export function MarkdownHtml(props: { text: string; live?: boolean }) {
  const [html] = createResource(
    () => props.text,
    (t) => renderMarkdown(t),
  );
  // Instant client-rendered fallback (same renderer as the live stream) shown
  // until the server HTML (chroma highlighting + sanitization) arrives and
  // silently upgrades it. Used for history too — opening a session otherwise
  // flashed RAW text → rendered as each block's /vh/render round-trip resolved.
  // The cost is bounded: only on-screen parts mount (Deferred), so this is a
  // handful of parses, not the whole transcript.
  const clientMd = createMemo(() => renderStreamMd(props.text));
  let ref: HTMLDivElement | undefined;
  createEffect(() => {
    if (html())
      queueMicrotask(() => {
        renderMathIn(ref); // LaTeX → MathML before linkifying (skips code/links)
        addCodeCopyButtons(ref);
        linkifyPaths(ref);
        tagInlineCodePaths(ref);
      });
  });
  const onClick = (e: MouseEvent) => {
    const tgt = e.target as HTMLElement;
    // Ctrl/Cmd-click a path-like inline code span (`src/foo.ts`) opens it — like
    // an editor's go-to. (Linkified .filepath spans, below, open on a plain click.)
    if (e.metaKey || e.ctrlKey) {
      const codeEl = tgt.closest("code") as HTMLElement | null;
      if (codeEl && !codeEl.closest("pre")) {
        const txt = (codeEl.textContent || "").trim();
        if (looksLikePath(txt)) {
          e.preventDefault();
          openFileAt(txt);
          return;
        }
      }
    }
    const t = tgt.closest(".filepath") as HTMLElement | null;
    if (t?.dataset.path) openFileAt(t.dataset.path, t.dataset.line ? Number(t.dataset.line) : undefined);
  };
  return (
    <Show
      when={html()}
      fallback={<div class="md" innerHTML={clientMd()} />}
    >
      <div class="md" ref={ref} innerHTML={html()!} onClick={onClick} />
    </Show>
  );
}

// Markdown block: while streaming, show raw growing text (live mode) or hold it
// back entirely (block-by-block mode — the Working… shimmer covers progress).
// Once settled, render prose server-side and any mermaid fences as diagrams.
// While streaming, render markdown live on the client (debounced — re-parsing
// the whole text per token is O(n²)) so the in-flight reply is formatted, not
// raw. The settled view re-renders it server-side (highlighting + mermaid).
function Markdown(props: { text: string; settled: boolean; caret?: boolean }) {
  // Captured at creation: true only for a block that started while streaming
  // (the message the user is watching). History blocks are created already
  // settled → false → cheap raw fallback (no per-block client parse on load).
  const live = !props.settled;
  const streamingView = () => {
    if (!streamLive()) return <></>;
    let host: HTMLDivElement | undefined;
    let engine: StreamMd | undefined;
    // A detached caret node re-attached after each render (the active block is
    // rebuilt each render, which removes it), placed at the end of the last line.
    const caretEl = document.createElement("span");
    caretEl.className = "stream-caret";
    caretEl.setAttribute("aria-hidden", "true");

    // Render via the incremental engine, coalesced to a fixed rate and only when
    // the text actually changes (idle between deltas). 5fps keeps the live
    // formatted reveal smooth while bounding paint work per second.
    const FRAME_MS = 200; // ~5fps
    let timer: number | undefined;
    let lastRender = 0;
    // `force` re-formats the trailing block on demand (used on tab-resume so
    // inline markdown snaps in with the raw text, not up to REPARSE_MS later).
    // Steady-state flushes pass false and stay throttled by the REPARSE_MS cap
    // (heat guardrail — forced reparse is once-per-resume, never per-frame).
    const flush = (force = false) => {
      timer = undefined;
      if (!host) return;
      lastRender = performance.now();
      (engine ||= new StreamMd(host)).push(props.text, lastRender, force);
      if (props.caret) placeStreamCaret(host, caretEl);
    };
    createEffect(() => {
      void props.text;  // re-run as deltas arrive
      void props.caret; // and when this stops/starts being the tail
      if (props.settled || timer !== undefined) return; // a render is already queued — coalesce
      timer = window.setTimeout(flush, Math.max(0, FRAME_MS - (performance.now() - lastRender)));
    });
    // Snap-on-resume: while the tab is hidden the browser throttles setTimeout
    // to ≥1s (intensive throttling → ~once/30s), so flush() rarely fires and the
    // rendered length falls behind the store's text. On return to visible, cancel
    // any queued (throttled) tick and flush now — StreamMd.push drains an
    // arbitrarily large delta in one call, so the part snaps to the latest text
    // in a single frame instead of slowly floating in.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (props.settled) return; // live engine is unmounted on settle — nothing to snap
      if (timer === undefined) return; // nothing queued → renderer is current, nothing to snap
      clearTimeout(timer);
      timer = undefined;
      flush(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", onVisible);
      if (timer !== undefined) clearTimeout(timer);
    });
    return <div class="md md-stream" ref={host} />;
  };
  return (
    <Show when={props.settled} fallback={streamingView()}>
      <For each={splitMermaid(props.text)}>
        {(seg) => (seg.type === "mermaid" ? <MermaidViewer src={seg.content} /> : <MarkdownHtml text={seg.content} live={live} />)}
      </For>
    </Show>
  );
}

// Reasoning block with a live "thinking" duration. While the part is still
// streaming the timer ticks (created → now); once it ends it shows the total.
function ReasoningPart(props: { part: Part; settled: boolean; tail?: boolean }) {
  const start = () => props.part.time?.start;
  const end = () => props.part.time?.end;
  const live = () => !props.settled && !end();
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!live() || !start()) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(t));
  });
  const elapsed = () => {
    const s = start();
    if (!s) return "";
    const secs = Math.max(0, Math.round(((end() ?? now()) - s) / 1000));
    return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  };
  // Controlled (not native <details>) so the open state lives in the id-keyed
  // store and survives streaming re-renders. Default open only for the tail (the
  // live thinking) — no truncated snippet in the header; the body is the content.
  const expanded = () => partOpen[props.part.id] ?? !!props.tail;
  const toggle = () => setPartOpen(props.part.id, !expanded());
  // Keep the body mounted once opened so the close animation has content.
  const [revealed, setRevealed] = createSignal(expanded());
  createEffect(() => {
    if (expanded()) setRevealed(true);
  });
  // Bounded, scrollable body that sticks to the bottom while streaming — unless
  // the user scrolled up (then it stays put). A ResizeObserver on the content
  // re-anchors when new tokens grow it; onScroll tracks whether we're stuck.
  let bodyEl: HTMLDivElement | undefined;
  let contentEl: HTMLDivElement | undefined;
  let stick = true;
  const onScroll = () => {
    const e = bodyEl;
    if (e) stick = e.scrollHeight - e.scrollTop - e.clientHeight < 24;
  };
  createEffect(() => {
    if (!expanded() || !bodyEl || !contentEl) return;
    stick = true; // (re)opening starts anchored at the bottom
    const ro = new ResizeObserver(() => {
      if (stick && bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
    });
    ro.observe(contentEl);
    onCleanup(() => ro.disconnect());
  });
  return (
    <div class={styles.reasoning} classList={{ open: expanded() }}>
      <button type="button" class="tool-head reasoning-head" onClick={toggle}>
        <span class={styles["tool-ico"]}><Icon name="help" size={13} /></span>
        <span class="tool-name">Thinking</span>
        <span class={styles["tool-subject"]} />
        <Show when={elapsed()}>
          <span class={`tool-dur ${styles["reasoning-time"]}`} classList={{ live: live() }}>{elapsed()}</span>
        </Show>
        <span class={styles["tool-chev"]} classList={{ rot: expanded() }}><Icon name="chevronDown" size={12} /></span>
      </button>
      <div class={styles.disclosure} classList={{ open: expanded() }}>
        <div class={styles["disclosure-clip"]}>
          <Show when={revealed()}>
            <div class="reasoning-body" ref={bodyEl} onScroll={onScroll}>
              <div ref={contentEl}>
                <Markdown text={(props.part.text as string) || ""} settled={props.settled} caret={props.tail} />
              </div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}

export default function PartView(props: { part: Part; settled?: boolean; tail?: boolean }) {
  const p = () => props.part;
  // A part is settled (worth the full markdown render) when the part itself has
  // ended, or when the owning message is settled — user messages never stream,
  // and a completed assistant turn settles all its parts at once.
  const settled = () => props.settled || !!p().time?.end;
  return (
    <Switch>
      <Match when={p().type === "text"}>
        <Markdown text={(p().text as string) || ""} settled={settled()} caret={props.tail} />
      </Match>
      <Match when={p().type === "reasoning"}>
        <ReasoningPart part={p()} settled={settled()} tail={props.tail} />
      </Match>
      <Match when={p().type === "tool"}>
        <ToolPart part={p()} tail={props.tail} />
      </Match>
      <Match when={p().type === "file"}>
        <div class={styles["file-chip"]}>📎 {(p().filename as string) || (p().mime as string)}</div>
      </Match>
      {/* step-start/finish, snapshot, patch, agent, retry, compaction: omitted in v1 */}
    </Switch>
  );
}

// ActivityGroup renders a run of consecutive tool/reasoning parts as one compact
// "Activity" timeline (OpenChamber-style): a header that discloses the full list
// with a smooth open/close animation, and per-row expand-to-full-detail (every
// tool, not just some — our deliberate divergence from OpenChamber). Collapsed
// shows only the header + count; the LAST group in the conversation auto-opens.
export function ActivityGroup(props: { parts: Part[]; settled: boolean; tailId?: string | null; isLast?: boolean }) {
  // Expanded by default (the activity timeline shouldn't hide itself); `override`
  // records a manual toggle and then wins, so a group you collapsed stays
  // collapsed as fresh activity streams in.
  const [override, setOverride] = createSignal<boolean | null>(null);
  const expanded = () => override() ?? true;
  const total = () => props.parts.length;
  // Keep the rows mounted once revealed so the collapse animation has content to
  // shrink; a never-opened old group renders no rows at all (cheap history).
  const [revealed, setRevealed] = createSignal(expanded());
  createEffect(() => {
    if (expanded()) setRevealed(true);
  });
  return (
    <div class={styles.activity}>
      <button
        type="button"
        class={styles["activity-head"]}
        aria-expanded={expanded()}
        onClick={() => setOverride(!expanded())}
      >
        <Icon name="cpu" size={14} />
        <span class={styles["activity-title"]}>Activity</span>
        <span class={styles["activity-count"]}>{total()}</span>
        <span class={styles["activity-chev"]} classList={{ rot: expanded() }}><Icon name="chevronDown" size={12} /></span>
      </button>
      <div class={styles["activity-rows-wrap"]} classList={{ open: expanded() }}>
        <div class={styles["activity-rows"]}>
          <Show when={revealed()}>
            <For each={props.parts}>
              {(p) => (
                <Switch>
                  <Match when={p.type === "reasoning"}>
                    <ReasoningPart part={p} settled={props.settled} tail={p.id === props.tailId} />
                  </Match>
                  <Match when={p.type === "tool"}>
                    <ToolPart part={p} tail={p.id === props.tailId} />
                  </Match>
                </Switch>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}
