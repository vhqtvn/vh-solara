// MessageParts — extracted from ChatView.tsx (C2 concern).
//
// Groups a single message's parts into render items and renders them. Two
// pieces live here:
//   - groupParts / RenderItem: a PURE helper that walks a message's partOrder
//     and folds consecutive tool/reasoning parts into one "activity" group,
//     leaving text/file parts inline. The `key` on each RenderItem is derived
//     from the part-id composition ONLY — it never changes when a part's text
//     grows — so a streaming turn keeps stable keys token-to-token and the row
//     components can be reused instead of recreated.
//   - MessageParts: the SolidJS component that calls groupParts, memoizes the
//     result, and REUSES the wrapper object for an unchanged key (the per-row
//     cache below) so parts update reactively via in-place refs with no
//     flashing/jumping. Also owns the F-SHAPE-B partless-completed safety net.
//
// ChatView renders MessageParts INSIDE its outer <For> (one per message row);
// this extraction does not change that — the `.msg[data-mid]` wrapper, gestures,
// Deferred, and row ownership all stay in ChatView.
import { createMemo, For, Show } from "solid-js";
import PartView, { ActivityGroup } from "../Part";
import Spinner from "../Spinner";
import { messageError } from "./messageMeta";

// Group a message's parts for rendering: consecutive tool/reasoning parts fold
// into one compact "Activity" timeline; text/file parts (and a lone reasoning
// with no tools) render inline as before. Preserves part order.
// RenderItem carries a `key` derived from the part-id composition. The key only
// changes when a part is ADDED/REMOVED — not when a part's text grows — so a
// streaming turn keeps the same keys token-to-token, letting MessageParts reuse
// the row components (parts mutate in place; see upsertPart) instead of
// recreating them every token.
export type RenderItem = { kind: "part"; part: any; key: string } | { kind: "activity"; parts: any[]; key: string };
export function groupParts(m: any): RenderItem[] {
  const items: RenderItem[] = [];
  let run: any[] = [];
  const flush = () => {
    if (!run.length) return;
    const hasTool = run.some((p) => p?.type === "tool");
    if (run.length === 1 && !hasTool) items.push({ kind: "part", part: run[0], key: "p:" + run[0].id });
    else items.push({ kind: "activity", parts: run, key: "a:" + run.map((p) => p.id).join(",") });
    run = [];
  };
  for (const pid of m.partOrder || []) {
    const p = m.parts[pid];
    if (!p) continue;
    if (p.type === "tool" || p.type === "reasoning") run.push(p);
    else {
      flush();
      items.push({ kind: "part", part: p, key: "p:" + p.id });
    }
  }
  flush();
  return items;
}

// Renders one message's parts. Memoizes the render-items and REUSES the wrapper
// object for an unchanged key, so the row components persist across streaming
// tokens (no flashing/jumping) and update reactively via the in-place part refs.
export function MessageParts(props: {
  m: any;
  isLastMessage: () => boolean;
  lastActivityKey: () => string | null;
  // F-SHAPE-B: session-level hydration failed (state.messagesError[sid]). Drives
  // the failed variant of the partless placeholder so a failed hydration is
  // EXPLICIT (an error hint) rather than an infinite loading spinner.
  failed: () => boolean;
}) {
  let cache = new Map<string, RenderItem>();
  const items = createMemo(() => {
    const fresh = groupParts(props.m);
    const next = new Map<string, RenderItem>();
    const out = fresh.map((it) => {
      const reused = cache.get(it.key) ?? it;
      next.set(it.key, reused);
      return reused;
    });
    cache = next;
    return out;
  });
  const settled = () => props.m.info.role === "user" || !!props.m.info.time?.completed;
  const tailId = () =>
    !settled() && props.isLastMessage() ? props.m.partOrder[props.m.partOrder.length - 1] : null;
  // F-SHAPE-B UX safety net for S5: a COMPLETED assistant message with ZERO
  // resident renderable parts. This is the residual hydration window the S5
  // primary (daemon-side parts-serving) cannot fully close — the brief fetch
  // gap before parts arrive, OR a real fetch failure. Without this guard the
  // message head (role/model/time/cost) renders over an EMPTY .msg-parts: a
  // silent "completed, 0 parts" message. The predicate is shape-based and
  // independent of the Go-side mechanism:
  //   - assistant + time.completed  → the turn finished, so it SHOULD have parts
  //   - items().length === 0        → none are resident yet (or fetch failed)
  //   - no per-message model error  → model-level errors are already surfaced
  //                                  via .msg-error; don't double-indicate.
  // Excludes user messages (always resident) and in-flight assistant turns
  // (completed falsy → a live stream shows its own active affordances).
  const partless = () =>
    props.m.info.role === "assistant" &&
    !!props.m.info.time?.completed &&
    !messageError(props.m.info) &&
    items().length === 0;
  return (
    <>
      <Show when={partless()}>
        <div
          class="msg-partless"
          role="status"
          aria-live="polite"
          data-failed={props.failed() ? "true" : "false"}
        >
          <Show
            when={!props.failed()}
            fallback={<span class="msg-partless-glyph" aria-hidden="true">⚠</span>}
          >
            <Spinner size={12} />
          </Show>
          <span class="msg-partless-text">
            {props.failed() ? "Message failed to load" : "Loading message\u2026"}
          </span>
        </div>
      </Show>
      <For each={items()}>
        {(it) =>
          it.kind === "activity" ? (
            <ActivityGroup
              parts={it.parts}
              settled={settled()}
              tailId={tailId()}
              isLast={it.parts[0]?.id === props.lastActivityKey()}
            />
          ) : (
            <PartView part={it.part} settled={settled()} tail={it.part.id === tailId()} />
          )
        }
      </For>
    </>
  );
}
