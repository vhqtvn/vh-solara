// ChatTasksStatus — extracted from ChatView.tsx.
//
// The status row pinned above the composer (out of the scroll area, so it never
// scrolls away): the Working pill on the left, the Tasks pill on the right when
// there are open tasks. Owns the server-authoritative subtree-todo poll and the
// Tasks popover (open/close, resize, outside-click dismiss). Pure
// presentational + polling: the Working-status signals (working / verb /
// verbElapsed / workingAriaLabel) are passed in as accessors by the parent
// ChatView; this component touches no scroll surface, no composer, and no CSS.
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { fetchSubtreeTodos, type SubtreeTodosResp } from "../subtreeTodos";
import type { CurrentVerb } from "../sync";
import { bindBackDismiss } from "../lib/backStack";
import { layoutPx } from "../lib/zoom";
import Icon from "./Icon";
import Spinner from "./Spinner";

// Props are accessors (SolidJS reactive getters), not values, so reactivity is
// preserved without re-wrapping. sessionId/draft drive the poll effect; the four
// working-status accessors drive the Working pill. No scroll/composer inputs.
export default function ChatTasksStatus(props: {
  sessionId: string;
  draft?: boolean;
  working: () => boolean;
  verb: () => CurrentVerb | null;
  verbElapsed: () => string;
  workingAriaLabel: () => string;
}) {
  // Agent todo list (OpenCode TodoWrite) → "Tasks N active · M left" pill.
  // Server-authoritative subtree rollup (P5): replaces the FE resident-map walk
  // (sessionTodos/sessionTodoCounts) which omitted unloaded descendants of
  // collapsed frontier nodes. Fetched on session change and polled every 5s
  // while the session is open (mirrors the fetchQueue pattern above) — the
  // server is authoritative, and a 5s poll catches todo.updated events without
  // wiring a stream→component refetch signal. Stale responses from a prior
  // session (or after unmount) are suppressed via a monotonic request id.
  const [subtreeTodos, setSubtreeTodos] = createSignal<SubtreeTodosResp["data"] | null>(null);
  let todoPollReq = 0;
  createEffect(() => {
    const sid = props.sessionId;
    if (props.draft || !sid) {
      setSubtreeTodos(null);
      return;
    }
    const myReq = ++todoPollReq;
    const poll = async () => {
      try {
        const resp = await fetchSubtreeTodos(sid);
        if (myReq !== todoPollReq) return; // superseded by a later session / unmount
        setSubtreeTodos(resp.data);
      } catch {
        if (myReq === todoPollReq) setSubtreeTodos(null);
      }
    };
    void poll();
    const timer = setInterval(poll, 5000);
    onCleanup(() => {
      clearInterval(timer);
      todoPollReq++; // suppress any in-flight fetch from this run
    });
  });
  const todoCounts = createMemo(() => subtreeTodos()?.totals ?? { active: 0, left: 0, total: 0 });
  const todoItems = createMemo(() => subtreeTodos()?.items ?? []);
  const [todosOpen, setTodosOpen] = createSignal(false);
  // Browser back dismisses the Tasks popover (same bindBackDismiss wiring every
  // peer popover — settings, admin, codepicker, … — uses; the binding dies with
  // this component, releasing its entry if still open).
  bindBackDismiss(() => todosOpen(), () => setTodosOpen(false), "taskspop");
  let tasksBarEl: HTMLDivElement | undefined;
  let tasksPopupEl: HTMLDivElement | undefined;
  // The popover is anchored bottom-right, so resizing means changing its size
  // (it grows up/left). A top-left grip drags it; size persists. Restore on open.
  // The grip lives on the popup shell (not the inner scroller) so it stays put
  // when the task list is scrolled.
  const TASKS_SIZE_KEY = "vh.prefs.tasksSize.v1";
  const restoreTasksSize = (el: HTMLElement) => {
    try {
      const s = JSON.parse(localStorage.getItem(TASKS_SIZE_KEY) || "null");
      if (s?.w) el.style.width = s.w;
      if (s?.h) { el.style.height = s.h; el.style.maxHeight = s.h; }
    } catch {
      /* ignore */
    }
  };
  const startTasksResize = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = tasksPopupEl;
    if (!el) return;
    // Pointer coords arrive in OUTER/viewport px while the width/height styles
    // below are zoomed-layout px (UI zoom = CSS `zoom` on :root; see
    // lib/zoom) — convert them, and read the start size via offsetWidth/
    // offsetHeight (the element's own layout px; getBoundingClientRect would
    // report visual px under zoom). innerHeight is viewport px too, so the
    // max-height clamp converts as well.
    const sx = layoutPx(e.clientX), sy = layoutPx(e.clientY), sw = el.offsetWidth, sh = el.offsetHeight;
    const move = (ev: PointerEvent) => {
      const w = Math.max(220, Math.min(560, sw + (sx - layoutPx(ev.clientX)))); // drag left → wider
      const h = Math.max(120, Math.min(layoutPx(window.innerHeight) * 0.72, sh + (sy - layoutPx(ev.clientY)))); // drag up → taller
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      el.style.maxHeight = `${h}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(TASKS_SIZE_KEY, JSON.stringify({ w: el.style.width, h: el.style.height }));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  // Close the overlay popover on outside click. Listener lives only while open;
  // onCleanup re-runs when todosOpen flips false, so nothing leaks.
  createEffect(() => {
    if (!todosOpen()) return;
    const onDoc = (e: MouseEvent) => {
      if (tasksBarEl && !e.composedPath().includes(tasksBarEl)) setTodosOpen(false);
    };
    const id = setTimeout(() => document.addEventListener("click", onDoc), 0);
    onCleanup(() => {
      clearTimeout(id);
      document.removeEventListener("click", onDoc);
    });
  });

  // Status row pinned above the composer (out of the scroll area, so it never
  // scrolls away): Working on the left, the Tasks pill on the right when there
  // are open tasks.
  return (
    <Show when={props.working() || todoCounts().left > 0}>
      <div class="chat-status">
        <Show when={props.working()}>
          <div class="working" role="status" aria-live="polite" aria-label={props.workingAriaLabel()}>
            <svg class="vh-inline-mark" viewBox="440 212 136 136" aria-hidden="true">
              <g class="vh-base">
                <path d="M440,236L483,325L498,326L541,237L526,237L493,307L490,309L455,236Z" />
                <path d="M563,236L563,272L561,274L533,274L528,286L562,286L563,326L576,326L576,236Z" />
                <path d="M518,229L513,229L496,266L501,266Z" />
                <path d="M535,300L535,305L547,313L535,321L536,326L554,316L554,311Z" />
                <path d="M490,235L471,246L471,250L490,261L490,255L478,248L490,240Z" />
                <path d="M530,295L524,296L508,331L513,331Z" />
              </g>
              <path class="vh-current" d="M449 236L486 318L493 309L535 237M569 236L569 277L533 280L568 282L569 326" />
              <path class="vh-current hot" d="M449 236L486 318L493 309L535 237M569 236L569 277L533 280L568 282L569 326" />
            </svg>
            {/* Verb + (optional subject) + animated ellipsis + elapsed. The dots
                sit at the END of the activity description (right before the
                timer) so "Reading parser.go... · 4s" and "Thinking... · 3s"
                stay consistent; subject truncates with ellipsis like .tool-subject. */}
            <span class="working-text">
              <span class="working-verb">{props.verb()?.verb ?? "Working"}</span>
              <Show when={props.verb()?.subject}>
                {(s) => <span class="working-subject">{s()}</span>}
              </Show>
              <span class="working-dots" aria-hidden="true" />
              <Show when={props.verbElapsed()}>
                {(e) => <span class="working-elapsed" aria-hidden="true"> · {e()}</span>}
              </Show>
            </span>
          </div>
        </Show>
        <Show when={todoCounts().left > 0}>
      <div class="tasks-bar" classList={{ open: todosOpen() }} ref={tasksBarEl}>
        <button type="button" class="tasks-pill" onClick={() => setTodosOpen((v) => !v)} aria-expanded={todosOpen()}>
          <span class="tasks-label">Tasks</span>
          <span class="tasks-count">{todoCounts().active} active</span>
          <span class="tasks-sep">·</span>
          <span class="tasks-count">{todoCounts().left} left</span>
          <span class="tasks-chev" classList={{ rot: todosOpen() }}><Icon name="chevronDown" size={12} /></span>
        </button>
        <Show when={todosOpen()}>
          <div class="tasks-popup" ref={(el) => { tasksPopupEl = el; restoreTasksSize(el); }}>
            {/* Top-left grip: drag to resize (grows up/left from the anchor).
                On the shell, not the scroller, so it's always reachable. */}
            <span class="tasks-resize" title="Drag to resize" onPointerDown={startTasksResize} />
            <ul class="tasks-list">
              <For each={todoItems()}>
                {(t) => (
                  <li class="tasks-item" classList={{ done: t.status === "completed", active: t.status === "in_progress", cancelled: t.status === "cancelled" }}>
                    <span class="tasks-item-ico">
                      <Switch fallback={<span class="tasks-pending" />}>
                        <Match when={t.status === "in_progress"}><Spinner size={13} /></Match>
                        <Match when={t.status === "completed"}><Icon name="check" size={13} /></Match>
                        <Match when={t.status === "cancelled"}><Icon name="x" size={12} /></Match>
                      </Switch>
                    </span>
                    <span class="tasks-item-text">{t.content || "(untitled)"}</span>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
      </div>
        </Show>
      </div>
    </Show>
  );
}
