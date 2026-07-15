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
  // Focus target for a KEYBOARD-initiated open: "first" (ArrowDown/Enter/Space)
  // or "last" (ArrowUp). null on a mouse open → focus the selected option, else
  // the first. Plain mutable (not a signal) so it never re-triggers the open
  // focus effect; it is read once when open() flips true and reset after.
  let pendingFocus: "first" | "last" | null = null;
  const current = () => props.options.find((o) => o.value === props.value);
  const isMobile = () => typeof matchMedia !== "undefined" && matchMedia("(max-width: 640px)").matches;

  function toggle() {
    if (open()) return setOpen(false);
    if (btn) setRect(btn.getBoundingClientRect());
    setOpen(true);
  }

  // ---- Keyboard navigation (APG "Listbox Collapsible") -------------------
  // DOM-focus-move model: real .focus() between option <button>s (NOT
  // aria-activedescendant, which would fight the real-button design).

  // Live, currently-rendered option buttons. The popup mounts via <Portal>
  // when open, so re-query the DOM each time. Disabled options are skipped.
  const listOptions = (): HTMLButtonElement[] =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>("[role='listbox'] .vh-select-opt"),
    ).filter((b) => !b.disabled);

  const labelOf = (b: HTMLButtonElement): string =>
    (b.querySelector(".vh-select-opt-label") as HTMLElement | null)?.textContent ??
    b.textContent ??
    "";

  // Move DOM focus to an option and keep it visible inside the popup scroll.
  const focusOpt = (el: HTMLButtonElement) => {
    el.focus();
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  };

  // Keydown on the TRIGGER while CLOSED. ArrowDown/Enter/Space open + focus
  // first; ArrowUp opens + focus last. preventDefault stops Space scrolling and
  // the native Enter/Space→click that would toggle the button back closed.
  // Escape while closed is left to bubble (e.g. an ancestor dialog close).
  const onTriggerKey = (e: KeyboardEvent) => {
    if (open()) return;
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pendingFocus = "first";
      if (btn) setRect(btn.getBoundingClientRect());
      setOpen(true);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      pendingFocus = "last";
      if (btn) setRect(btn.getBoundingClientRect());
      setOpen(true);
    }
  };

  // Keydown on `document` while OPEN (focus is in the listbox, or still on the
  // trigger after a click-open). Escape always closes; everything else needs at
  // least one enabled option.
  const onListKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      btn?.focus();
      return;
    }
    const opts = listOptions();
    if (!opts.length) return;
    const active = document.activeElement as HTMLElement | null;
    const idx = opts.findIndex((b) => b === active);
    const inList = idx !== -1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusOpt(opts[(idx + 1 + opts.length) % opts.length]);
        return;
      case "ArrowUp":
        e.preventDefault();
        focusOpt(opts[(idx - 1 + opts.length) % opts.length]);
        return;
      case "Home":
        e.preventDefault();
        focusOpt(opts[0]);
        return;
      case "End":
        e.preventDefault();
        focusOpt(opts[opts.length - 1]);
        return;
      case "Enter":
      case " ":
        // Select the focused option, close, restore focus to the trigger.
        // preventDefault suppresses the native button-click Enter/Space would
        // otherwise fire (double-firing onChange); reusing .click() invokes the
        // option's own onClick → pick (disabled guard + onChange + close).
        if (inList) {
          e.preventDefault();
          (active as HTMLButtonElement).click();
          btn?.focus();
        }
        return;
      case "Tab":
        // Default browser behavior — do NOT trap. The popup is left to close on
        // a subsequent outside-click/Escape (APG listbox allows Tab to leave).
        return;
    }
    // Type-ahead: a single printable char focuses the next option whose label
    // starts with it (case-insensitive), cycling through matches.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const ch = e.key.toLowerCase();
      const start = inList ? (idx + 1) % opts.length : 0;
      for (let i = 0; i < opts.length; i++) {
        const j = (start + i) % opts.length;
        if (labelOf(opts[j]).trim().toLowerCase().startsWith(ch)) {
          e.preventDefault();
          focusOpt(opts[j]);
          return;
        }
      }
    }
  };

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

  // When the popup opens, move DOM focus into the listbox (APG: focus the
  // selected option, else the first; keyboard-open overrides via pendingFocus).
  // Deferred to a microtask so the <Portal>-mounted options are in the DOM.
  createEffect(() => {
    if (!open()) return;
    const want = pendingFocus;
    queueMicrotask(() => {
      const opts = listOptions();
      if (!opts.length) {
        pendingFocus = null;
        return;
      }
      let target: HTMLButtonElement;
      if (want === "last") target = opts[opts.length - 1];
      else if (want === "first") target = opts[0];
      else {
        const selIdx = opts.findIndex((b) => b.classList.contains("sel"));
        target = selIdx !== -1 ? opts[selIdx] : opts[0];
      }
      pendingFocus = null;
      focusOpt(target);
    });
  });

  createEffect(() => {
    if (open()) {
      document.addEventListener("keydown", onListKey);
      window.addEventListener("scroll", onScroll, true);
    } else {
      document.removeEventListener("keydown", onListKey);
      window.removeEventListener("scroll", onScroll, true);
    }
  });
  onCleanup(() => {
    document.removeEventListener("keydown", onListKey);
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
        onKeyDown={onTriggerKey}
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
