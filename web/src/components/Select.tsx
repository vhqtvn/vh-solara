import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import Icon from "./Icon";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  swatch?: string; // optional color dot (a CSS color/var) shown before the label
  sub?: string; // optional secondary line under the label (e.g. a description)
}

// A custom dropdown replacing native <select>. The popup is PORTALED to <body>
// and positioned fixed against the trigger's rect, so it's never clipped by an
// ancestor's overflow (settings dialog) and flips up when there's no room below
// (composer bar at the screen bottom). On small screens it's a centered sheet.
export default function Select(props: {
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  class?: string;
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  const [rect, setRect] = createSignal<DOMRect | null>(null);
  let btn: HTMLButtonElement | undefined;
  let popEl: HTMLDivElement | undefined;
  const current = () => props.options.find((o) => o.value === props.value);
  const isMobile = () => typeof matchMedia !== "undefined" && matchMedia("(max-width: 640px)").matches;

  function toggle() {
    if (open()) return setOpen(false);
    if (btn) setRect(btn.getBoundingClientRect());
    setOpen(true);
  }

  // Close on Escape. Outside-click is handled by the scrim/overlay below.
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
  // On an ancestor scroll (e.g. a scrollable dialog body) the fixed-positioned
  // popup would go stale — REPOSITION it to follow the trigger rather than close
  // (closing broke opening a select inside a scrollable container, since the
  // open-click's scroll-into-view fired this). Scrolls inside the popup's own
  // list are ignored.
  const onScroll = (e: Event) => {
    const t = e.target as Node | null;
    if (popEl && t && popEl.contains(t)) return;
    if (btn) setRect(btn.getBoundingClientRect());
  };
  createEffect(() => {
    if (open()) {
      document.addEventListener("keydown", onKey);
      window.addEventListener("scroll", onScroll, true);
    } else {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    }
  });
  onCleanup(() => {
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("scroll", onScroll, true);
  });

  // Fixed position against the trigger; flips up if below would overflow.
  const popStyle = () => {
    const r = rect();
    if (!r) return {};
    const maxH = Math.min(340, Math.round(window.innerHeight * 0.55));
    const below = window.innerHeight - r.bottom;
    const flipUp = below < Math.min(maxH, 220) && r.top > below;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - r.width));
    const base: Record<string, string> = {
      position: "fixed",
      left: `${left}px`,
      "min-width": `${r.width}px`,
      "max-height": `${maxH}px`,
    };
    if (flipUp) base.bottom = `${Math.round(window.innerHeight - r.top + 4)}px`;
    else base.top = `${Math.round(r.bottom + 4)}px`;
    return base;
  };

  const pick = (o: SelectOption) => {
    if (o.disabled) return;
    props.onChange(o.value);
    setOpen(false);
  };

  const Options = () => (
    <For each={props.options}>
      {(o) => (
        <button
          type="button"
          class="vh-select-opt"
          classList={{ sel: o.value === props.value, disabled: o.disabled }}
          role="option"
          aria-selected={o.value === props.value}
          disabled={o.disabled}
          onClick={() => pick(o)}
        >
          <Show when={o.swatch}>
            <span class="vh-select-swatch" style={{ background: o.swatch! }} aria-hidden="true" />
          </Show>
          <span class="vh-select-opt-text">
            <span class="vh-select-opt-label">{o.label}</span>
            <Show when={o.sub}>
              <span class="vh-select-opt-sub">{o.sub}</span>
            </Show>
          </span>
          <Show when={o.value === props.value}>
            <Icon name="check" size={13} />
          </Show>
        </button>
      )}
    </For>
  );

  return (
    <div class={`vh-select ${props.class ?? ""}`} classList={{ open: open(), disabled: props.disabled }}>
      <button
        ref={btn}
        type="button"
        class="vh-select-btn"
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-label={props.ariaLabel}
        disabled={props.disabled}
        onClick={toggle}
      >
        <Show when={current()?.swatch}>
          <span class="vh-select-swatch" style={{ background: current()!.swatch! }} aria-hidden="true" />
        </Show>
        <span class="vh-select-label">{current()?.label ?? props.placeholder ?? "Select…"}</span>
        <Icon name="chevronDown" size={13} />
      </button>
      <Show when={open()}>
        <Portal>
          <Show
            when={isMobile()}
            fallback={
              <>
                <div class="vh-select-scrim" onClick={() => setOpen(false)} />
                <div ref={popEl} class="vh-select-pop" role="listbox" style={popStyle()}>
                  <Options />
                </div>
              </>
            }
          >
            <div class="vh-select-overlay" onClick={() => setOpen(false)}>
              <div class="vh-select-sheet" role="listbox" onClick={(e) => e.stopPropagation()}>
                <Options />
              </div>
            </div>
          </Show>
        </Portal>
      </Show>
    </div>
  );
}
