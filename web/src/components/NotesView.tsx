import { createSignal, For, onMount, Show } from "solid-js";
import { addTodo, loadNotes, notesDoc, removeTodo, saveState, setNotes, toggleTodo } from "../notes";
import Icon from "./Icon";
import "./NotesView.css";

// Project-level notes + todos, persisted on the daemon so they sync across
// devices and survive reconnects. Notes are free-form markdown; todos are a
// simple user-authored checklist.
export default function NotesView() {
  const [draft, setDraft] = createSignal("");
  onMount(loadNotes);

  const remaining = () => notesDoc.todos.filter((t) => !t.done).length;

  function submitTodo(e: Event) {
    e.preventDefault();
    addTodo(draft());
    setDraft("");
  }

  return (
    <div class="notes-view">
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
    </div>
  );
}
