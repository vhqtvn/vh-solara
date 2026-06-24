// Transient, dismissable notifications (errors, turn-complete). Unlike
// OpenCode's persistent toasts, these accumulate into a Facebook-style list
// behind the header bell and can be dismissed individually or all at once.
// Live, actionable items (pending permissions/questions) are NOT stored here —
// they are derived from the sync store so they clear themselves on reply.
import { createStore, produce } from "solid-js/store";

export type NotifyKind = "error" | "done" | "info" | "waiting";

export interface Notification {
  id: string;
  kind: NotifyKind;
  sessionID?: string;
  title: string;
  detail?: string;
  time: number;
  read: boolean;
  // The daemon notice type (finished|waiting|stuck-thinking|runaway|stalled) when
  // this came from an alert — lets us auto-mark-read the right ones as state
  // resolves. Absent for client-side notifications (errors, etc.).
  tag?: string;
}

interface NotifyState {
  items: Notification[];
}

const MAX = 50;
const [notifications, setNotifications] = createStore<NotifyState>({ items: [] });

let seq = 0;
// De-dupe rapid duplicates (e.g. the same error re-emitted) within a short window.
const recent = new Map<string, number>();

export function pushNotification(n: Omit<Notification, "id" | "time" | "read">) {
  const key = `${n.kind}:${n.sessionID || ""}:${n.title}`;
  const now = Date.now();
  const last = recent.get(key);
  if (last && now - last < 4000) return;
  recent.set(key, now);
  setNotifications(
    produce((s) => {
      s.items.unshift({ ...n, id: `n${++seq}`, time: now, read: false });
      if (s.items.length > MAX) s.items.length = MAX;
    }),
  );
}

export function dismissNotification(id: string) {
  setNotifications("items", (xs) => xs.filter((n) => n.id !== id));
}

export function clearNotifications() {
  setNotifications("items", []);
}

export function markAllRead() {
  setNotifications(produce((s) => s.items.forEach((n) => (n.read = true))));
}

// Mark matching notifications as read (without removing them) — used to auto-ack
// a "needs input" nudge once the request is answered, or a "finished" nudge once
// the session is archived. They stay in the list as history; the unread count drops.
export function markRead(pred: (n: Notification) => boolean) {
  setNotifications(produce((s) => s.items.forEach((n) => { if (pred(n)) n.read = true; })));
}

export { notifications };
