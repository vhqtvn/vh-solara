import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { fetchArchived, restoreAndOpen, unarchiveSession } from "../archive";
import type { Session } from "../types";
import Icon from "./Icon";
import RelTime from "./RelTime";
import "./ArchivedDialog.css";

// Lazy, paginated archived-session browser. Roots load in pages (50 at a time);
// a node's children load only when expanded. This bounds memory/DOM regardless
// of how many thousands of archived sessions a project has.

interface LevelState {
  rows: Session[];
  childCounts: Record<string, number>;
  total: number;
  loaded: number;
}


export default function ArchivedDialog(props: { onClose: () => void }) {
  const PAGE = 50;
  // Per-parent level cache ("" = roots). childCounts merge across levels.
  const [levels, setLevels] = createStore<Record<string, LevelState>>({});
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});
  const [busy, setBusy] = createSignal(false);
  // Which level ("" = roots) is currently fetching, so its "Load more" button can
  // show "Loading…" instead of appearing frozen.
  const [loadingParent, setLoadingParent] = createSignal<string | null>(null);

  async function loadLevel(parent: string, append = false) {
    setBusy(true);
    setLoadingParent(parent);
    try {
      const cur = levels[parent];
      const offset = append && cur ? cur.loaded : 0;
      const lvl = await fetchArchived(parent, offset, PAGE);
      setLevels(parent, (prev) => {
        const rows = append && prev ? [...prev.rows, ...lvl.sessions] : lvl.sessions;
        return {
          rows,
          childCounts: { ...(prev?.childCounts || {}), ...lvl.childCounts },
          total: lvl.total,
          loaded: rows.length,
        };
      });
    } finally {
      setBusy(false);
      setLoadingParent(null);
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => {
    document.addEventListener("keydown", onKey);
    void loadLevel("");
  });
  onCleanup(() => document.removeEventListener("keydown", onKey));

  function toggle(id: string) {
    const open = !expanded()[id];
    setExpanded((e) => ({ ...e, [id]: open }));
    if (open && !levels[id]) void loadLevel(id);
  }

  async function restore(id: string, e: Event) {
    e.stopPropagation();
    await unarchiveSession(id);
    // Drop the row from its level cache so it disappears from the browser.
    for (const parent of Object.keys(levels)) {
      const lvl = levels[parent];
      if (lvl?.rows.some((r) => r.id === id)) {
        setLevels(parent, "rows", (rows) => rows.filter((r) => r.id !== id));
        setLevels(parent, "loaded", (n) => Math.max(0, n - 1));
        setLevels(parent, "total", (n) => Math.max(0, n - 1));
      }
    }
  }

  function Row(p: { s: Session; parent: string; depth: number }) {
    const id = p.s.id;
    const kids = () => levels[p.parent]?.childCounts[id] || 0;
    return (
      <>
        <div class="arch-row" style={{ "padding-left": `${10 + p.depth * 16}px` }}>
          <button
            type="button"
            class="arch-twisty"
            classList={{ leaf: kids() === 0 }}
            aria-label={expanded()[id] ? "Collapse" : "Expand"}
            onClick={() => kids() > 0 && toggle(id)}
          >
            <Show when={kids() > 0}>
              <span classList={{ open: expanded()[id] }}>
                <Icon name="chevronDown" size={13} />
              </span>
            </Show>
          </button>
          <button type="button" class="arch-main" onClick={() => restoreAndOpen(id).then(props.onClose)}>
            <span class="arch-title">{p.s.title || id}</span>
            <span class="arch-meta">
              <Show when={kids() > 0}>
                <span class="arch-count">{kids()}</span>
              </Show>
              <RelTime class="arch-time" ms={p.s.time?.updated || p.s.time?.created} />
            </span>
          </button>
          <button type="button" class="arch-restore" data-tip="Restore" onClick={(e) => restore(id, e)}>
            Restore
          </button>
        </div>
        <Show when={expanded()[id] && levels[id]}>
          <For each={levels[id].rows}>{(c) => <Row s={c} parent={id} depth={p.depth + 1} />}</For>
          <Show when={levels[id].loaded < levels[id].total}>
            <button
              type="button"
              class="arch-more"
              style={{ "padding-left": `${10 + (p.depth + 1) * 16}px` }}
              disabled={loadingParent() === id}
              onClick={() => loadLevel(id, true)}
            >
              {loadingParent() === id ? "Loading…" : `Load more (${levels[id].total - levels[id].loaded})`}
            </button>
          </Show>
        </Show>
      </>
    );
  }

  const roots = () => levels[""];

  return (
    <div class="dialog-overlay" onClick={props.onClose}>
      <div class="dialog archived" role="dialog" aria-label="Archived sessions" onClick={(e) => e.stopPropagation()}>
        <div class="dialog-head">
          <span class="dialog-title">
            Archived sessions
            <Show when={roots()}> · {roots()!.total}</Show>
          </span>
          <button type="button" class="icon-btn" aria-label="Close" onClick={props.onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div class="dialog-body arch-body">
          <Show
            when={roots() && roots()!.rows.length > 0}
            fallback={<p class="setting-hint">{busy() ? "Loading…" : "No archived sessions."}</p>}
          >
            <For each={roots()!.rows}>{(s) => <Row s={s} parent="" depth={0} />}</For>
            <Show when={roots()!.loaded < roots()!.total}>
              <button type="button" class="arch-more" disabled={loadingParent() === ""} onClick={() => loadLevel("", true)}>
                {loadingParent() === "" ? "Loading…" : `Load more (${roots()!.total - roots()!.loaded})`}
              </button>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}
