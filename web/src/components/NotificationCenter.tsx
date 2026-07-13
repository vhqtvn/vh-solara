import { createMemo, createSignal, For, Show } from "solid-js";
import { selectedId, setSelectedId, state } from "../sync";
import { dismiss } from "../lib/a11y";
import { clearNotifications, dismissNotification, markAllRead, notifications } from "../notify";
import { setView } from "../ui";
import { displayName } from "../projectSettings";
import Icon from "./Icon";
import RelTime from "./RelTime";

const KIND_ICON = { done: "check", error: "alert", info: "info", waiting: "help" } as const;

// Header bell + Facebook-style dropdown. Two kinds of entries:
//  • Action needed — pending permissions/questions across all sessions, derived
//    live from the store so they vanish the moment they're answered.
//  • Recent — dismissable transient notes (errors, turn-complete).
export default function NotificationCenter() {
  const [open, setOpen] = createSignal(false);

  // Pending interactive requests across every session.
  const actions = createMemo(() => {
    const out: { key: string; sessionID: string; kind: "permission" | "question"; title: string }[] = [];
    for (const [sid, perms] of Object.entries(state.permissions)) {
      for (const p of Object.values(perms)) {
        out.push({ key: "p" + p.id, sessionID: sid, kind: "permission", title: p.title || p.type || "Permission requested" });
      }
    }
    for (const [sid, qs] of Object.entries(state.questions)) {
      for (const q of Object.values(qs)) {
        const first = (q.questions || [])[0];
        out.push({ key: "q" + q.id, sessionID: sid, kind: "question", title: first?.question || "Answer needed" });
      }
    }
    return out;
  });

  const count = createMemo(() => actions().length + notifications.items.filter((n) => !n.read).length);
  const sessionName = (sid?: string) => (sid ? displayName(state.sessions[sid]?.title || "Session") : "");

  function toggle() {
    const next = !open();
    setOpen(next);
    if (next) markAllRead();
  }
  function goto(sid?: string) {
    if (sid && sid !== selectedId()) setSelectedId(sid);
    // Switch to the Chat tab — the notification points at a session message, so
    // Changes/Notes/an embedded view would show nothing relevant.
    setView("chat");
    setOpen(false);
  }

  const empty = () => actions().length === 0 && notifications.items.length === 0;

  return (
    <div class="notif" use:dismiss={() => open() && setOpen(false)}>
      <button type="button" class="icon-btn notif-bell" aria-label="Notifications" data-tip="Notifications" onClick={toggle}>
        <Icon name="bell" />
        <Show when={count() > 0}>
          <span class="notif-badge">{count() > 9 ? "9+" : count()}</span>
        </Show>
      </button>
      <Show when={open()}>
        <div class="notif-menu" role="dialog" aria-label="Notifications">
          <div class="notif-menu-head">
            <span>Notifications</span>
            <Show when={notifications.items.length > 0}>
              <button
                type="button"
                class="notif-clear"
                onClick={(e) => {
                  e.stopPropagation();
                  clearNotifications();
                }}
              >
                Clear
              </button>
            </Show>
          </div>
          <div class="notif-list">
            <Show when={actions().length > 0}>
              <div class="notif-section">Action needed</div>
              <For each={actions()}>
                {(a) => (
                  <button type="button" class="notif-item action" onClick={() => goto(a.sessionID)}>
                    <span class="notif-ico">
                      <Icon name={a.kind === "question" ? "help" : "info"} size={15} />
                    </span>
                    <span class="notif-body">
                      <span class="notif-title">{a.title}</span>
                      <span class="notif-meta">{sessionName(a.sessionID)}</span>
                    </span>
                  </button>
                )}
              </For>
            </Show>
            <Show when={notifications.items.length > 0}>
              <div class="notif-section">Recent</div>
              <For each={notifications.items}>
                {(n) => (
                  <div class="notif-item" classList={{ err: n.kind === "error", done: n.kind === "done", info: n.kind === "info", waiting: n.kind === "waiting", read: n.read }}>
                    <span class="notif-ico"><Icon name={KIND_ICON[n.kind]} size={15} /></span>
                    <button type="button" class="notif-body btn" onClick={() => goto(n.sessionID)}>
                      <span class="notif-title">
                        <Show when={n.sessionID}>
                          <b class="notif-session">{sessionName(n.sessionID)}</b>{" "}
                        </Show>
                        {n.title}
                      </span>
                      <Show when={n.detail}>
                        <span class="notif-detail">{n.detail}</span>
                      </Show>
                      <RelTime class="notif-time" mode="ago" ms={n.time} />
                    </button>
                    <button
                      type="button"
                      class="notif-x"
                      aria-label="Dismiss"
                      onClick={(e) => {
                        // Stop the click reaching the outside-click handler — the
                        // item node detaches on dismiss, which would otherwise read
                        // as a click outside the popup and close it.
                        e.stopPropagation();
                        dismissNotification(n.id);
                      }}
                    >
                      <Icon name="x" size={13} />
                    </button>
                  </div>
                )}
              </For>
            </Show>
            <Show when={empty()}>
              <div class="notif-empty">You're all caught up.</div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
