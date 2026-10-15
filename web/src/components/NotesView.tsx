import { createSignal, For, onMount, Show } from "solid-js";
import { addTodo, loadNotes, notesDoc, removeTodo, saveState, setNotes, toggleTodo } from "../notes";
import { einkProfile } from "../prefs";
import { EinkSurfacePaging } from "./EinkSurfacePaging";
import Icon from "./Icon";
import "./NotesView.css";

// Project-level notes + todos, persisted on the daemon so they sync across
// devices and survive reconnects. Notes are free-form markdown; todos are a
// simple user-authored checklist.
//
// E-ink profile (UX Slice 3b): under the profile the pane gains discrete
// vertical paging over its owned overflow through the shared EinkSurfacePaging
// adapter (lib/paging.ts geometry, reused verbatim — no second engine). The
// notes pane is a PANE scroller (`.notes-view` fills `.view-primary`, a
// row-flex parent), so the S3 "reserved in-flow row beside a bounded scroller"
// placement needs a column wrapper: under ON the root `.notes-view` is
// restyled (inline — NotesView.css is outside this slice's file scope) into a
// column flex whose first child is the scroller and whose second child is the
// paging bar, so the scroller YIELDS the bar's height (the S1/S2/S3
// "reserve space, never cover" rule — nothing is occluded). The OFF branch is
// byte-identical to the pre-profile tree: profile OFF mounts no wrapper
// overrides, no bar, no observers (the OFF render/event path is unchanged).
// Note-editing semantics (input/textarea handlers, form submit, toggles) are
// untouched — the adapter only writes the pane scroller's scrollTop.
export default function NotesView() {
  const [draft, setDraft] = createSignal("");
  onMount(loadNotes);

  const remaining = () => notesDoc.todos.filter((t) => !t.done).length;

  function submitTodo(e: Event) {
    e.preventDefault();
    addTodo(draft());
    setDraft("");
  }

  // The pane content (both sections). A closure, not a component: each branch
  // below calls it, so every branch renders FRESH DOM bound to the same
  // signals (a profile toggle swaps branches without sharing disposed nodes).
  const body = () => (
    <div class="notes-inner">
        <section class="notes-section">
          <div class="notes-head">
            <h2>To-dos</h2>
            <Show when={notesDoc.todos.length > 0}>
              <span class="notes-count">{remaining()} left</span>
            </Show>
          </div>
          <form class="todo-add" onSubmit={submitTodo}>
            <input
              type="text"
              placeholder="Add a to-do…"
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
            />
            <button type="submit" class="todo-add-btn" aria-label="Add to-do" disabled={!draft().trim()}>
              <Icon name="plus" size={16} />
            </button>
          </form>
          <Show when={notesDoc.todos.length > 0} fallback={<p class="notes-empty">No to-dos yet.</p>}>
            <ul class="todo-list">
              <For each={notesDoc.todos}>
                {(t) => (
                  <li class="todo-item" classList={{ done: t.done }}>
                    <button
                      type="button"
                      class="todo-check"
                      aria-label={t.done ? "Mark not done" : "Mark done"}
                      onClick={() => toggleTodo(t.id)}
                    >
                      <Show when={t.done}>
                        <Icon name="check" size={13} />
                      </Show>
                    </button>
                    <span class="todo-text">{t.text}</span>
                    <button
                      type="button"
                      class="todo-del"
                      aria-label="Delete to-do"
                      onClick={() => removeTodo(t.id)}
                    >
                      <Icon name="x" size={13} />
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

        <section class="notes-section">
          <div class="notes-head">
            <h2>Notes</h2>
            <span class="notes-saved" classList={{ error: saveState() === "error" }}>
              {saveState() === "saving" ? "Saving…" : saveState() === "error" ? "Save failed — retries on edit" : "Saved on server"}
            </span>
          </div>
          <textarea
            class="notes-text"
            placeholder="Project notes (markdown)…"
            value={notesDoc.notes}
            onInput={(e) => setNotes(e.currentTarget.value)}
          />
        </section>
      </div>
  );

  // ON: the pane becomes a column (root `.notes-view` restyled inline — see
  // the header comment) holding the scroller + the adapter's reserved row.
  // OFF: the exact pre-profile single-div tree.
  let scrollEl: HTMLDivElement | undefined;
  return (
    <Show when={einkProfile()} fallback={<div class="notes-view">{body()}</div>}>
      <div
        class="notes-view"
        style={{ display: "flex", "flex-direction": "column", "overflow-y": "hidden" }}
      >
        <div ref={scrollEl} style={{ flex: "1 1 auto", "min-height": "0", "overflow-y": "auto" }}>
          {body()}
        </div>
        <EinkSurfacePaging name="notes" axis="y" label="Notes paging" target={() => scrollEl} />
      </div>
    </Show>
  );
}
