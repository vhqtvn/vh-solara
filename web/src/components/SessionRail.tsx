// SessionRail — the P1 portrait session-monitor rail.
//
// A 48px full-height column of per-session avatars that renders ONLY in the
// NARROW width tier (<560 visual px) while the shape-tier kill-switch is on
// (`widthTier() === "narrow"` — the tier signal is null when the flag is off,
// so flag-off never mounts the rail: exact legacy drawer-only behavior). It
// sits BESIDE the chat as an adjacent flex column (never an overlay — the
// drawer is the only covering surface), with:
//
//   - a vertically-scrolling avatar stack (stable tree order; state rings for
//     needs-input / error / running / unread; a selection ring on the selected
//     session's ROOT avatar — root granularity, the tab-pairs precedent);
//   - pinned aggregates at the bottom (needs-you count + connection dot) and
//     the drawer opener, kept visible via flex order (an empty session dir
//     shows just opener + aggregates).
//
// Tapping an avatar jumps to that session (openSessionChat: select + snap to
// chat). Embedded and standalone render identically — the gate is the tier
// signal alone; there is no isEmbedded() branch anywhere in this stack.
//
// Derivations live in ../sessionRail.ts (unit-tested); this file is markup +
// wiring only. Styles: SessionRail.css (a PLAIN all-global co-located
// stylesheet — an all-:global .module.css exports an empty class map that a
// production build tree-shakes away; plain CSS always ships. The e2e suite
// queries this surface by stable class names — the ProjectSwitcher.css
// precedent in docs/ai/web-css-architecture.md).
import { For, Show, createMemo } from "solid-js";
import { selectedId, state } from "../sync/store";
import { rootOf } from "../sync/selectors";
import { setNavOpen } from "../ui";
import { widthTier } from "../shapeTier";
import { railSessions, railNeedsYou, railConnState, ringOf } from "../sessionRail";
import { openSessionChat } from "./SessionTree";
import Icon from "./Icon";
import "./SessionRail.css";

export default function SessionRail() {
  // The single render gate: tier signal LIVE and narrow. Null (kill-switch
  // off, or the first pre-observation frame) renders nothing — the legacy
  // drawer-only layout, byte-exact.
  const visible = () => widthTier() === "narrow";
  const sessions = createMemo(() => railSessions());
  const needsYou = createMemo(() => railNeedsYou());
  // The selection ring marks the selected session's ROOT avatar (root
  // granularity). A selection whose session is not resident (a stale ghost
  // id) marks nothing.
  const selRoot = createMemo(() => {
    const id = selectedId();
    return id && state.sessions[id] ? rootOf(id) : null;
  });

  return (
    <Show when={visible()}>
      <nav class="session-rail" aria-label="Sessions">
        <div class="rail-scroll">
          <For each={sessions()}>
            {(s) => {
              const ring = () => ringOf(s);
              const selected = () => selRoot() === s.id;
              return (
                <button
                  type="button"
                  class="rail-avatar"
                  classList={{ selected: selected() }}
                  data-session-id={s.id}
                  data-ring={ring() ?? undefined}
                  aria-label={`Open ${s.title || s.id}`}
                  aria-current={selected() ? "true" : undefined}
                  onClick={() => openSessionChat(s.id)}
                >
                  <span class={`rail-chip hue${s.hue}`}>{s.initials}</span>
                </button>
              );
            }}
          </For>
        </div>
        <div class="rail-foot">
          <Show when={needsYou() > 0}>
            <span
              class="rail-needs"
              data-count={needsYou()}
              role="status"
              aria-label={`${needsYou()} session${needsYou() === 1 ? "" : "s"} need you`}
            >
              {needsYou() > 9 ? "9+" : needsYou()}
            </span>
          </Show>
          <span class="rail-conn" data-state={railConnState()} aria-hidden="true" />
          <button
            type="button"
            class="rail-open"
            aria-label="Open session drawer"
            data-tip="Sessions"
            onClick={() => setNavOpen(true)}
          >
            <Icon name="menu" size={18} />
          </button>
        </div>
      </nav>
    </Show>
  );
}
