import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { addProject, fetchRecentProjects, projectDir, projects, removeProject, selectProject } from "../projects";
import Icon from "./Icon";
import TextPromptDialog from "./TextPromptDialog";

// Project switcher: pick the active project directory (re-scopes the whole UI to
// that OpenCode workspace). Pinned projects persist locally; "Recent" comes from
// OpenCode (GET /project); "Add project…" takes an absolute path.
export default function ProjectSwitcher() {
  const [open, setOpen] = createSignal(false);
  const [recents, { refetch }] = createResource(fetchRecentProjects, { initialValue: [] });
  const current = () => projects().find((p) => p.directory === projectDir()) || projects()[0];

  // Recents not already pinned (and not the active one).
  const freshRecents = createMemo(() => {
    const pinned = new Set(projects().map((p) => p.directory));
    return recents().filter((r) => !pinned.has(r.directory) && r.directory !== projectDir());
  });

  let rootEl: HTMLDivElement | undefined;
  const onDoc = (e: MouseEvent) => {
    if (open() && rootEl && !e.composedPath().includes(rootEl)) setOpen(false);
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
  onMount(() => {
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
  });
  onCleanup(() => {
    document.removeEventListener("click", onDoc);
    document.removeEventListener("keydown", onKey);
  });

  function openMenu() {
    setOpen((v) => !v);
    if (!open()) void refetch(); // refresh recents when opening
  }
  const [addOpen, setAddOpen] = createSignal(false);
  function add() {
    setOpen(false);
    setAddOpen(true);
  }

  return (
    <div class="proj" ref={rootEl}>
      <button type="button" class="proj-current" onClick={openMenu} data-tip={current()?.directory || "Default"}>
        <Icon name="layers" size={14} />
        <span class="proj-name">{current()?.name}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      <Show when={open()}>
        <div class="proj-menu" role="menu">
          <For each={projects()}>
            {(p) => (
              <div class="proj-item" classList={{ on: p.directory === projectDir() }}>
                <button type="button" class="proj-pick" onClick={() => (selectProject(p.directory), setOpen(false))}>
                  <span class="proj-item-name">{p.name}</span>
                  <Show when={p.directory}>
                    <span class="proj-item-dir">{p.directory}</span>
                  </Show>
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
              {(p) => (
                <div class="proj-item">
                  <button type="button" class="proj-pick" onClick={() => (addProject(p.directory), setOpen(false))}>
                    <span class="proj-item-name">{p.name}</span>
                    <span class="proj-item-dir">{p.directory}</span>
                  </button>
                </div>
              )}
            </For>
          </Show>

          <button type="button" class="proj-add" onClick={add}>
            <Icon name="plus" size={14} /> Add project…
          </button>
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
