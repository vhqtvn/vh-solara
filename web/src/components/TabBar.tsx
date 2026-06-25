import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { tabStyle } from "../prefs";
import Icon from "./Icon";
import Select from "./Select";

export interface TabItem {
  key: string;
  label: string;
  icon?: string;
}

// Header view switcher with priority+ overflow: it measures the available width
// and collapses whatever doesn't fit into a "⋯" menu, so the header never wraps
// no matter how many views (built-in + embedded) exist. The display style is
// user-configurable (labels / icons / a single dropdown). The dropdown style
// can't overflow by construction; labels/icons share the measured-overflow path.
export default function TabBar(props: { items: () => TabItem[]; active: () => string; onSelect: (key: string) => void }) {
  let rowEl: HTMLDivElement | undefined;
  let measureEl: HTMLDivElement | undefined;
  let wrapEl: HTMLDivElement | undefined;
  const [avail, setAvail] = createSignal(0);
  const [widths, setWidths] = createSignal<number[]>([]);
  const [menuOpen, setMenuOpen] = createSignal(false);

  const GAP = 4;
  const MORE_W = 40;

  // Measure each item's natural width from a hidden, fully-rendered row. Re-run
  // when the item set or the style changes (queueMicrotask: after the DOM paints).
  const measure = () => {
    if (!measureEl) return;
    setWidths([...measureEl.children].map((c) => (c as HTMLElement).getBoundingClientRect().width));
  };
  createEffect(() => {
    props.items();
    tabStyle();
    queueMicrotask(measure);
  });

  onMount(() => {
    if (!wrapEl) return;
    // Measure the flex container (stable available space), not the content row
    // (which sizes to its content and would oscillate).
    const ro = new ResizeObserver(() => setAvail(wrapEl!.clientWidth));
    ro.observe(wrapEl);
    setAvail(wrapEl.clientWidth);
    onCleanup(() => ro.disconnect());
  });

  // How many leading items fit (reserving room for the ⋯ button when some spill).
  const visibleCount = createMemo(() => {
    const ws = widths();
    const n = props.items().length;
    const a = avail();
    if (!a || ws.length !== n) return n;
    const fits = (limit: number) => {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        sum += ws[i] + (i > 0 ? GAP : 0);
        if (sum > limit) return i;
      }
      return n;
    };
    if (fits(a) === n) return n;
    return Math.max(1, fits(a - MORE_W)); // make room for ⋯
  });

  const visible = createMemo(() => props.items().slice(0, visibleCount()));
  const hidden = createMemo(() => props.items().slice(visibleCount()));

  // Close the overflow menu on outside click.
  const onDoc = (e: MouseEvent) => {
    if (wrapEl && !e.composedPath().includes(wrapEl)) setMenuOpen(false);
  };
  createEffect(() => {
    if (menuOpen()) document.addEventListener("click", onDoc);
    else document.removeEventListener("click", onDoc);
  });
  onCleanup(() => document.removeEventListener("click", onDoc));

  const tabBtn = (it: TabItem, inMenu = false) => (
    <button
      type="button"
      class={inMenu ? "tabbar-menu-item" : "tabbar-tab"}
      classList={{ on: props.active() === it.key, icon: !inMenu && tabStyle() === "icons" }}
      data-tip={!inMenu && tabStyle() === "icons" ? it.label : undefined}
      aria-label={it.label}
      onClick={() => {
        props.onSelect(it.key);
        setMenuOpen(false);
      }}
    >
      <Show when={(inMenu || tabStyle() === "icons") && it.icon}>
        <span class="tabbar-ico"><Icon name={it.icon!} size={14} /></span>
      </Show>
      <Show when={inMenu || tabStyle() !== "icons"}>
        <span class="tabbar-label">{it.label}</span>
      </Show>
    </button>
  );

  return (
    <Show
      when={tabStyle() !== "dropdown"}
      fallback={
        <Select
          class="tabbar-select"
          ariaLabel="View"
          value={props.active()}
          options={props.items().map((it) => ({ value: it.key, label: it.label }))}
          onChange={props.onSelect}
        />
      }
    >
      <div class="tabbar" classList={{ icons: tabStyle() === "icons" }} ref={wrapEl}>
        <div class="tabbar-row seg" ref={rowEl}>
          <For each={visible()}>{(it) => tabBtn(it)}</For>
        </div>
        <Show when={hidden().length > 0}>
          <div class="tabbar-overflow">
            <button
              type="button"
              class="tabbar-more"
              classList={{ on: hidden().some((it) => it.key === props.active()) }}
              aria-label="More views"
              data-tip="More views"
              onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
            >
              <span class="tabbar-more-dots">•••</span>
              <Icon name="chevronDown" size={11} />
            </button>
            <Show when={menuOpen()}>
              <div class="tabbar-menu">
                <For each={hidden()}>{(it) => tabBtn(it, true)}</For>
              </div>
            </Show>
          </div>
        </Show>
        {/* Hidden measuring row: all items at natural width (never wraps). */}
        <div class="tabbar-row seg tabbar-measure" ref={measureEl} aria-hidden="true">
          <For each={props.items()}>{(it) => tabBtn(it)}</For>
        </div>
      </div>
    </Show>
  );
}
