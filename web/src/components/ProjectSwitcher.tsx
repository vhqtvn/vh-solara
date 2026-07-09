import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import {
  ActivityMaps,
  addProject,
  fetchProjectActivity,
  fetchRecentProjects,
  mergeProjectActivity,
  projectDir,
  projects,
  removeProject,
  selectProject,
} from "../projects";
import { dismiss, modal } from "../lib/a11y";
import { runningSessionCount, rootSessionCount } from "../sync";
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
  const [open, setOpen] = createSignal(false);
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

  const current = () => projects().find((p) => p.directory === projectDir()) || projects()[0];

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

  function toggle() {
    const next = !open();
    setOpen(next);
    if (next) {
      void refetch(); // refresh recents when opening
      loadActivity(); // refresh activity when opening
    }
  }

  const [addOpen, setAddOpen] = createSignal(false);
  function add() {
    setOpen(false);
    setAddOpen(true);
  }

  return (
    <div class="proj">
      <button type="button" class="proj-current" onClick={toggle} data-tip={current()?.directory || "Default"}>
        <Icon name="layers" size={14} />
        <span class="proj-name">{current()?.name}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      <Show when={open()}>
        <div class="dialog-overlay" use:dismiss={() => setOpen(false)}>
          <div
            class="dialog projects-dialog"
            role="dialog"
            aria-label="Switch project"
            use:modal
            onClick={(e) => e.stopPropagation()}
          >
            <div class="dialog-head">
              <span class="dialog-title">Switch project</span>
              <button type="button" class="icon-btn" aria-label="Close" onClick={() => setOpen(false)}>
                <Icon name="x" size={14} />
              </button>
            </div>
            <div class="dialog-body">
              <For each={rows()}>
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
                        <Show when={p.directory} fallback="default workspace">
                          {p.directory}
                        </Show>
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
                      <button
                        type="button"
                        class="proj-remove"
                        aria-label="Remove project"
                        data-tip="Remove from list"
                        onClick={(e) => (e.stopPropagation(), removeProject(p.directory))}
                      >
                        <Icon name="x" size={13} />
                      </button>
                    </Show>
                  </div>
                )}
              </For>

              <Show when={freshRecents().length > 0}>
                <div class="proj-section">Recent (OpenCode)</div>
                <For each={freshRecents()}>
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
                      </div>
                    );
                  }}
                </For>
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
