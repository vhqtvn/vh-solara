import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";
import {
  ActivityMaps,
  addProject,
  buildProjectLink,
  fetchProjectActivity,
  fetchRecentProjects,
  filterProjectRows,
  mergeProjectActivity,
  projectDir,
  projects,
  removeProject,
  selectProject,
} from "../projects";
import { dismiss, modal } from "../lib/a11y";
import "./ProjectSwitcher.css";
import { runningSessionCount, rootSessionCount } from "../sync";
import { projSwitcherOpen as open, setProjSwitcherOpen as setOpen } from "../ui";
import Icon from "./Icon";
import TextPromptDialog from "./TextPromptDialog";

// Project switcher: pick the active project directory (re-scopes the whole UI to
// that OpenCode workspace). Opens as a DIALOG (not an inline dropdown) so the
// full list + activity badges are reachable on mobile and desktop alike. Pinned
// projects persist locally; "Recent" comes from OpenCode (GET /project); "Add
// project…" takes an absolute path. Activity (sessions/running counts) for the
// NON-active projects comes from GET /vh/projects + /vh/running-sessions; the
// active project uses the live client store to avoid a round-trip.
export default function ProjectSwitcher() {
  const [query, setQuery] = createSignal("");
  const [recents, { refetch }] = createResource(fetchRecentProjects, { initialValue: [] });

  // Activity is fetched ON DIALOG OPEN (coalesced, never a tight loop). Held as a
  // signal so rows/recent badges react when it resolves; an in-flight guard
  // dedupes concurrent triggers.
  const [activity, setActivity] = createSignal<ActivityMaps | null>(null);
  let inflight: Promise<void> | null = null;
  function loadActivity() {
    if (inflight) return;
    inflight = fetchProjectActivity()
      .then((m) => {
        setActivity(m);
      })
      .catch(() => {})
      .finally(() => {
        inflight = null;
      });
  }

  // The active project, or undefined when no project is selected (the daemon's
  // cwd is not a meaningful project, so nothing is pinned by default). The
  // trigger renders a "Select project" placeholder in that case.
  const current = () => projects().find((p) => p.directory === projectDir());

  // Inline remove-confirm state (Slice 3): clicking a pinned row's remove
  // button does NOT unpin immediately — instead that row enters a confirm
  // state showing inline Confirm/Cancel controls. Only ONE row can be pending
  // at a time: starting confirm on a different row overwrites this signal, so
  // the previous row reverts to its normal remove button (supersede — simpler
  // and more predictable than cancelling-first). Held as a single directory
  // string (or null), so the single-value signal itself enforces the one-at-a-
  // time rule with no extra bookkeeping.
  const [pendingRemove, setPendingRemove] = createSignal<string | null>(null);
  function startRemove(directory: string) {
    setPendingRemove(directory);
  }
  function confirmRemove(directory: string) {
    removeProject(directory);
    setPendingRemove(null);
  }
  function cancelRemove() {
    setPendingRemove(null);
  }

  // Focus management (S3): clicking a pinned row's Remove button replaces that
  // (focused) button with the .proj-confirm cluster — without a proactive move,
  // focus can fall to body. Land focus on the Confirm button instead. The ref
  // targets the single .proj-confirm-go button (only one confirm cluster exists
  // at a time — pendingRemove is single-valued). queueMicrotask yields so the
  // freshly-mounted cluster is in the DOM before .focus(); supersede (switching
  // from one row's confirm to another) sets pendingRemove to the new dir, the
  // old cluster unmounts + the new one mounts, and this effect re-runs to focus
  // the NEW confirm button.
  let confirmBtn: HTMLButtonElement | undefined;
  createEffect(() => {
    const dir = pendingRemove();
    if (dir) queueMicrotask(() => confirmBtn?.focus());
  });

  // Copy-link affordance (Slice 5): every NON-default project row (pinned AND
  // recents) gets a "Copy link" button that writes the per-project deep link
  // (`${origin}${pathname}?dir=<dir>`) to the clipboard. The copied row's icon
  // flips copy→check for ~1.5s as a confirmation — a cheap reactive DOM swap
  // mirroring the Part.tsx code-copy revert cadence (no animation, no
  // mask-image, no backdrop-filter: those punish Firefox/WebRender). The link
  // itself is also stashed in a `data-link` attribute so tests + inspect can
  // read it without the clipboard (clipboard read can be flaky in harness).
  // `copiedDir` is a single-value signal (like pendingRemove): only one row
  // shows "Copied" at a time, and the guarded revert keeps a later copy on a
  // different row from being cut short.
  const [copiedDir, setCopiedDir] = createSignal<string | null>(null);
  function projectLink(directory: string): string {
    return buildProjectLink(`${location.origin}${location.pathname}`, directory);
  }
  function copyLink(directory: string) {
    void navigator.clipboard?.writeText(projectLink(directory));
    setCopiedDir(directory);
    setTimeout(() => setCopiedDir((prev) => (prev === directory ? null : prev)), 1500);
  }
  // The button is shared across pinned + recents rows. Reads copiedDir from the
  // closure (component-local; there is a single ProjectSwitcher instance). The
  // reactive Icon `name` + classList + data-tip swap is the whole confirmation
  // — no extra DOM, no transition heavier than the icon glyph change.
  const CopyLinkButton = (p: { directory: string; name: string }) => {
    const copied = () => copiedDir() === p.directory;
    return (
      <button
        type="button"
        class="proj-copy"
        classList={{ copied: copied() }}
        data-tip={copied() ? "Copied!" : "Copy link"}
        data-link={projectLink(p.directory)}
        aria-label={copied() ? `Copied link to ${p.name}` : `Copy link to ${p.name}`}
        onClick={(e) => (e.stopPropagation(), copyLink(p.directory))}
      >
        <Icon name={copied() ? "check" : "copy"} size={13} />
      </button>
    );
  };

  // Open/close setup runs on EVERY open/close transition via this effect (not
  // inside toggle()), so every opener shares one path: the sidebar trigger
  // (toggle), the no-project empty-state CTA (NoProjectState →
  // setProjSwitcherOpen(true)), and any future setProjSwitcherOpen(true). On
  // the rising edge it clears the search query and refreshes recents + activity
  // (a stale filter/badge from one open must never bleed into the next). On the
  // falling edge it resets pendingRemove + copiedDir (a stale confirm/copied
  // state must never persist on a hidden row). Reading open() is the sole
  // dependency; the signals it writes do not write open(), so there is no loop.
  createEffect(() => {
    const o = open();
    if (o) {
      setQuery("");
      void refetch(); // refresh recents on each open
      loadActivity(); // refresh activity badges on each open
    } else {
      setPendingRemove(null);
      setCopiedDir(null);
    }
  });

  // Dismissal config for use:dismiss on the overlay. MUST be passed as an
  // OBJECT (not wrapped in an arrow): Solid compiles use:dismiss={expr} so the
  // directive receives an accessor () => expr, and dismiss() runs value() once
  // to pick its branch (a11y.ts: typeof v === "function" ? v : v.onClose).
  // Wrapping in `() => ({...})` makes value() return that arrow, takes the
  // function branch, and silently wires onClose/onEscape to a no-op arrow —
  // outside-click AND Escape dismissal both go dead. The object form makes
  // value() return the config so onClose (outside-click) closes the dialog and
  // onEscape cancels a pending confirm first, else closes. (ManagedPanel uses
  // the same const form — see its dismissOpts.)
  const dismissOpts = {
    onClose: () => setOpen(false),
    onEscape: () => {
      // Escape cancels an inline confirm first (rather than closing the whole
      // dialog); if no confirm is pending, Escape closes as usual.
      if (pendingRemove()) setPendingRemove(null);
      else setOpen(false);
    },
  };

  // Recents not already pinned (and not the active one).
  const freshRecents = createMemo(() => {
    const pinned = new Set(projects().map((p) => p.directory));
    return recents().filter((r) => !pinned.has(r.directory) && r.directory !== projectDir());
  });

  // Enriched + sorted rows (running-first, then case-insensitive name). The
  // active project uses live store counts (runningSessionCount() + rootSession
  // count); others use the endpoint activity data. Both counts are ROOT-ONLY
  // (children/archived excluded), so idle = roots − running is meaningful.
  const rows = createMemo(() =>
    mergeProjectActivity(
      projects(),
      activity() ?? { roots: new Map(), running: new Map() },
      projectDir(),
      runningSessionCount(),
      rootSessionCount(),
    ),
  );

  // Search/filter: case-insensitive substring on name OR directory. The filter
  // itself is pure (projects.ts → filterProjectRows); memos recompute only when
  // rows or query change.
  const filteredRows = createMemo(() => filterProjectRows(rows(), query()));
  const filteredRecents = createMemo(() => filterProjectRows(freshRecents(), query()));
  const hasAny = createMemo(() => rows().length > 0 || freshRecents().length > 0);
  const noResults = createMemo(
    () => hasAny() && query().trim() !== "" && filteredRows().length === 0 && filteredRecents().length === 0,
  );

  function toggle() {
    // The open/close setup (query clear, recents/activity refetch on open;
    // pendingRemove/copiedDir reset on close) lives in the createEffect keyed
    // on open() above, so EVERY opener (this trigger, the no-project CTA, any
    // setProjSwitcherOpen(true)) shares one path.
    setOpen(!open());
  }

  const [addOpen, setAddOpen] = createSignal(false);
  function add() {
    setOpen(false);
    setAddOpen(true);
  }

  return (
    <div class="proj">
      <button type="button" class="proj-current" onClick={toggle} data-tip={current()?.directory || "Select project"}>
        <Icon name="layers" size={14} />
        <span class="proj-name">{current()?.name ?? "Select project"}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      <Show when={open()}>
        <div class="dialog-overlay" use:dismiss={dismissOpts} onClick={() => setOpen(false)}>
          <div
            class="dialog projects-dialog"
            role="dialog"
            aria-label="Switch project"
            use:modal
            onClick={(e) => e.stopPropagation()}
          >
            <div class="dialog-head">
              <input
                class="dialog-search"
                placeholder="Search projects…"
                autocomplete="off"
                aria-label="Search projects"
                value={query()}
                onInput={(e) => (setQuery(e.currentTarget.value), setPendingRemove(null))}
              />
              <button type="button" class="icon-btn" aria-label="Close" onClick={() => setOpen(false)}>
                <Icon name="x" size={14} />
              </button>
            </div>
            <div class="dialog-body">
              <Show when={!hasAny()}>
                <p class="proj-empty">No projects yet — use “Add project…” to pin one.</p>
              </Show>
              <Show when={noResults()}>
                <p class="proj-empty">No matching projects</p>
              </Show>
              <Show when={hasAny() && !noResults()}>
              <For each={filteredRows()}>
                {(p) => (
                  <div class="proj-item" classList={{ on: p.active }}>
                    <button
                      type="button"
                      class="proj-pick"
                      aria-current={p.active ? "true" : undefined}
                      onClick={() => (selectProject(p.directory), setOpen(false))}
                    >
                      <span class="proj-item-name">
                        {p.name}
                        <Show when={p.active}>
                          <span class="proj-active" aria-hidden="true" />
                        </Show>
                      </span>
                      <span class="proj-item-dir">
                        {p.directory}
                        <Show when={p.running > 0 || p.idle > 0}>
                          {" \u00b7 "}
                          <span classList={{ "proj-badge": true, run: p.running > 0 }}>
                            <Show when={p.running > 0}>
                              <span class="proj-badge-dot" aria-hidden="true" />
                              {p.running} running
                            </Show>
                            <Show when={p.running > 0 && p.idle > 0}>{", "}</Show>
                            <Show when={p.idle > 0}>{p.idle} idle</Show>
                          </span>
                        </Show>
                      </span>
                    </button>
                    <Show when={p.directory}>
                      <Show
                        when={pendingRemove() === p.directory}
                        fallback={
                          <span class="proj-actions">
                            <CopyLinkButton directory={p.directory} name={p.name} />
                            <button
                              type="button"
                              class="proj-remove"
                              aria-label={`Remove ${p.name}`}
                              data-tip="Remove from list"
                              onClick={(e) => (e.stopPropagation(), startRemove(p.directory))}
                            >
                              <Icon name="x" size={13} />
                            </button>
                          </span>
                        }
                      >
                        <span class="proj-confirm">
                          <span class="proj-confirm-text" aria-hidden="true">Remove?</span>
                          <button
                            type="button"
                            class="proj-confirm-go"
                            ref={confirmBtn}
                            aria-label={`Confirm remove ${p.name}`}
                            onClick={(e) => (e.stopPropagation(), confirmRemove(p.directory))}
                          >
                            Remove
                          </button>
                          <button
                            type="button"
                            class="proj-confirm-cancel"
                            aria-label={`Cancel remove ${p.name}`}
                            onClick={(e) => (e.stopPropagation(), cancelRemove())}
                          >
                            Cancel
                          </button>
                        </span>
                      </Show>
                    </Show>
                  </div>
                )}
              </For>

              <Show when={filteredRecents().length > 0}>
                <div class="proj-section">Recent (OpenCode)</div>
                <For each={filteredRecents()}>
                  {(r) => {
                    // Recents may not be bridged in /vh/projects, so a root count
                    // is NOT guaranteed. When one IS present for this dir, show
                    // idle too (consistency with pinned rows); otherwise fall back
                    // to running-only. idle is defensive: max(0, roots − running).
                    const act = () => activity();
                    const rootsKnown = () => act()?.roots.has(r.directory) ?? false;
                    const run = () => act()?.running.get(r.directory) ?? 0;
                    const idle = () => (rootsKnown() ? Math.max(0, (act()!.roots.get(r.directory) ?? 0) - run()) : 0);
                    return (
                      <div class="proj-item">
                        <button type="button" class="proj-pick" onClick={() => (addProject(r.directory), setOpen(false))}>
                          <span class="proj-item-name">{r.name}</span>
                          <span class="proj-item-dir">
                            {r.directory}
                            <Show when={run() > 0 || idle() > 0}>
                              {" \u00b7 "}
                              <span classList={{ "proj-badge": true, run: run() > 0 }}>
                                <Show when={run() > 0}>
                                  <span class="proj-badge-dot" aria-hidden="true" />
                                  {run()} running
                                </Show>
                                <Show when={run() > 0 && idle() > 0}>{", "}</Show>
                                <Show when={idle() > 0}>{idle()} idle</Show>
                              </span>
                            </Show>
                          </span>
                        </button>
                        <CopyLinkButton directory={r.directory} name={r.name} />
                      </div>
                    );
                  }}
                </For>
              </Show>
              </Show>

              <button type="button" class="proj-add" onClick={add}>
                <Icon name="plus" size={14} /> Add project…
              </button>
            </div>
          </div>
        </div>
      </Show>
      <TextPromptDialog
        open={addOpen()}
        title="Add project"
        label="Project directory (absolute path):"
        placeholder="/home/you/project"
        confirmText="Add"
        onCancel={() => setAddOpen(false)}
        onConfirm={(path) => {
          addProject(path);
          setAddOpen(false);
        }}
      />
    </div>
  );
}
