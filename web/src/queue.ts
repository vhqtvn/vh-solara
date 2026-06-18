// Client-side message queue. OpenCode rejects a prompt sent while a session is
// busy (RunnerBusy), so to let the user line up follow-ups we hold them here and
// auto-send the next one when the session goes idle. Drained by the active
// session's ChatView (it owns the send machinery); persisted per session so a
// reload/switch doesn't lose pending messages.
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { loadVersioned, saveVersioned } from "./lib/store";

export interface QueuedAttachment {
  url: string;
  filename: string;
  mime: string;
}
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: QueuedAttachment[];
  // Captured at enqueue time so a later model/agent switch doesn't retroactively
  // change a queued message.
  sendConfig?: { providerID?: string; modelID?: string; variant?: string; agent?: string };
  createdAt: number;
}

const LS_QUEUE = "vh.queue.v1";
const LS_QUEUE_MODE = "vh.prefs.queueMode.v1";

const [queues, setQueues] = createStore<Record<string, QueuedMessage[]>>(
  loadVersioned<Record<string, QueuedMessage[]>>(LS_QUEUE, 1, {}, (o) =>
    o && typeof o === "object" ? (o as Record<string, QueuedMessage[]>) : {},
  ),
);

// Global toggle (default on, like openchamber). When off, sending while busy is
// blocked the old way instead of queuing.
const [queueMode, setQueueModeSig] = createSignal<boolean>(
  loadVersioned<boolean>(LS_QUEUE_MODE, 1, true, (o) => !(o === 0 || o === "0" || o === false)),
);
export function setQueueMode(on: boolean) {
  setQueueModeSig(on);
  saveVersioned(LS_QUEUE_MODE, 1, on);
}
export { queueMode };

function persist() {
  saveVersioned(LS_QUEUE, 1, { ...queues });
}

let counter = 0;
export function enqueue(sessionId: string, msg: Omit<QueuedMessage, "id" | "createdAt">) {
  const item: QueuedMessage = { ...msg, id: `q-${Date.now()}-${counter++}`, createdAt: Date.now() };
  setQueues(produce((q) => {
    (q[sessionId] ||= []).push(item);
  }));
  persist();
}

export function queueFor(sessionId: string): QueuedMessage[] {
  return queues[sessionId] || [];
}

export function removeQueued(sessionId: string, id: string) {
  setQueues(produce((q) => {
    if (q[sessionId]) q[sessionId] = q[sessionId].filter((m) => m.id !== id);
  }));
  persist();
}

// Pop the first queued message (FIFO) and return it, or undefined if empty.
export function dequeue(sessionId: string): QueuedMessage | undefined {
  const cur = queues[sessionId];
  if (!cur || cur.length === 0) return undefined;
  const first = cur[0];
  setQueues(produce((q) => {
    q[sessionId] = q[sessionId].slice(1);
  }));
  persist();
  return first;
}

export function clearQueue(ids: string[]) {
  let changed = false;
  setQueues(produce((q) => {
    for (const id of ids) {
      if (q[id]) {
        delete q[id];
        changed = true;
      }
    }
  }));
  if (changed) persist();
}
