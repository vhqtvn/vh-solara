// Project notes + todos, persisted on the daemon (/vh/notes) so they survive
// reconnects and sync across devices. The client keeps a local copy and
// debounces writes back to the server.
import { createStore } from "solid-js/store";

export interface Todo {
  id: string;
  text: string;
  done: boolean;
}
export interface NotesDoc {
  notes: string;
  todos: Todo[];
}

const [doc, setDoc] = createStore<NotesDoc>({ notes: "", todos: [] });
let loaded = false;

export async function loadNotes() {
  if (loaded) return;
  loaded = true;
  try {
    const res = await fetch("/vh/notes");
    if (res.ok) {
      const d = await res.json();
      setDoc({ notes: d.notes || "", todos: Array.isArray(d.todos) ? d.todos : [] });
    }
  } catch {
    /* offline: keep empty; next save will create it */
  }
}

let saveTimer: number | undefined;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, 500);
}
async function save() {
  try {
    await fetch("/vh/notes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: doc.notes, todos: doc.todos }),
    });
  } catch {
    /* will retry on the next edit */
  }
}

export function setNotes(text: string) {
  setDoc("notes", text);
  scheduleSave();
}

let seq = 0;
export function addTodo(text: string) {
  const t = text.trim();
  if (!t) return;
  setDoc("todos", (xs) => [...xs, { id: `t${Date.now()}_${seq++}`, text: t, done: false }]);
  scheduleSave();
}
export function toggleTodo(id: string) {
  setDoc("todos", (x) => x.id === id, "done", (d) => !d);
  scheduleSave();
}
export function removeTodo(id: string) {
  setDoc("todos", (xs) => xs.filter((x) => x.id !== id));
  scheduleSave();
}

export { doc as notesDoc };
