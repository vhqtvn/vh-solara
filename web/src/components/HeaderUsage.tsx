import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { contextUsage, fmtTok } from "../usage";
import QuotaPanel from "./QuotaPanel";

// OpenChamber-style header Usage indicator: a compact donut + context% pill,
// color-coded by threshold. Click opens a popover with the context breakdown,
// multi-provider quota, and a link to the full session inspector.
function tone(pct: number | null): "ok" | "warn" | "hot" {
  if (pct == null) return "ok";
  if (pct >= 90) return "hot";
  if (pct >= 75) return "warn";
  return "ok";
}

export default function HeaderUsage(props: { sessionId: string; onInspect: () => void }) {
  const [open, setOpen] = createSignal(false);
  const usage = createMemo(() => contextUsage(props.sessionId));

  let rootEl: HTMLDivElement | undefined;
  const onDoc = (e: MouseEvent) => {
    if (open() && rootEl && !e.composedPath().includes(rootEl)) setOpen(false);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
  };
  onMount(() => {
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
  });
  onCleanup(() => {
    document.removeEventListener("click", onDoc);
    document.removeEventListener("keydown", onKey);
  });

  // Donut geometry (r=7 → circumference ≈ 43.98).
  const C = 2 * Math.PI * 7;
  const pct = () => usage()?.pct ?? 0;

  return (
    <div class="usage" ref={rootEl}>
      <button
        type="button"
        class="usage-pill"
        classList={{ [`t-${tone(usage()?.pct ?? null)}`]: true }}
        aria-label="Usage"
        data-tip="Context & quota usage"
        onClick={() => setOpen((v) => !v)}
      >
        <svg class="usage-donut" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
          <circle class="usage-donut-bg" cx="9" cy="9" r="7" fill="none" stroke-width="3" />
          <circle
            class="usage-donut-fg"
            cx="9"
            cy="9"
            r="7"
            fill="none"
            stroke-width="3"
            stroke-dasharray={`${(pct() / 100) * C} ${C}`}
            transform="rotate(-90 9 9)"
            stroke-linecap="round"
          />
        </svg>
        <span class="usage-pct">
          <Show when={usage()} fallback={"Usage"}>
            {usage()!.pct != null ? `${usage()!.pct}%` : fmtTok(usage()!.used)}
          </Show>
        </span>
      </button>

      <Show when={open()}>
        <div class="usage-menu" role="dialog" aria-label="Usage">
          <div class="usage-menu-head">Context window</div>
          <Show when={usage()} fallback={<p class="setting-hint" style={{ margin: "0 0 8px" }}>No usage yet this session.</p>}>
            {(u) => (
              <div class="usage-ctx">
                <div class="usage-ctx-top">
                  <span>
                    {fmtTok(u().used)}
                    <Show when={u().limit}> / {fmtTok(u().limit)} tokens</Show>
                  </span>
                  <Show when={u().pct != null}>
                    <span class="usage-ctx-pct">{u().pct}%</span>
                  </Show>
                </div>
                <Show when={u().pct != null}>
                  <div class="usage-bar">
                    <div
                      class="usage-bar-fill"
                      classList={{ [`t-${tone(u().pct)}`]: true }}
                      style={{ width: `${u().pct}%` }}
                    />
                  </div>
                </Show>
              </div>
            )}
          </Show>

          <div class="usage-menu-head">Provider quota</div>
          <QuotaPanel />

          <button
            type="button"
            class="usage-details"
            onClick={() => {
              setOpen(false);
              props.onInspect();
            }}
          >
            Session details →
          </button>
        </div>
      </Show>
    </div>
  );
}
