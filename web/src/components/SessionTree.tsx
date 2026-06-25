import { createEffect, createMemo, For, Match, Show, Switch } from "solid-js";
import { createSignal } from "solid-js";
import { selectedId, setSelectedId, state, sessionNeedsInput } from "../sync";
import { setView } from "../ui";

// Picking a session always shows its chat — even re-clicking the already-open
// one while on another tab (Code/Changes) jumps you back to the conversation.
const openSessionChat = (id: string) => {
  setSelectedId(id);
  setView("chat");
};
import { treeDensity } from "../prefs";
import { isPinned, searchQuery } from "../sidebar";
import { buildChildrenIndex } from "../lib/reduce";
import { menuTriggers } from "../sessionMenu";
import type { Session } from "../types";
import Icon from "./Icon";
import Spinner from "./Spinner";
import { loadVersioned, saveVersioned } from "../lib/store";
import RelTime from "./RelTime";
import { formatDuration } from "../lib/time";

// --- per-node expand state ----------------------------------------------------
// Persisted state, cycled by clicking the twisty:
//   collapsed — no children shown (footer summarizes hidden running/idle counts)
//   filtered  — only children whose subtree is running (footer: hidden idle)
//   expanded  — all children, running grouped first
// Plus a transient `temp` (auto): an ancestor of the active session is revealed
// to JUST the child on the path. Default for an untouched node is `filtered`.
type TreeMode = "collapsed" | "filtered" | "expanded";
type DisplayState = TreeMode | "temp";
const LS_MODE = "vh.tree.mode.v2";

function loadModes(): Record<string, TreeMode> {
  const m = loadVersioned<Record<string, TreeMode>>(LS_MODE, 1, {}, (o) =>
    o && typeof o === "object" ? (o as Record<string, TreeMode>) : {},
  );
  if (Object.keys(m).length) return m;
  // Migrate the previous open/closed/running map.
  const old = loadVersioned<Record<string, string>>("vh.tree.mode.v1", 1, {}, (o) =>
    o && typeof o === "object" ? (o as Record<string, string>) : {},
  );
  const map: Record<string, TreeMode> = {};
  for (const [k, v] of Object.entries(old)) {
    map[k] = v === "open" ? "expanded" : v === "running" ? "filtered" : "collapsed";
  }
  return map;
}

const [treeMode, setTreeMode] = createSignal<Record<string, TreeMode>>(loadModes());
const modeOf = (id: string): TreeMode => treeMode()[id] || "filtered";
// Nodes the user toggled during the current selection — their persisted state
// then wins over the auto `temp` reveal (only for that node, until selection
// changes).
const [userToggled, setUserToggled] = createSignal<Set<string>>(new Set());

function persist(next: Record<string, TreeMode>) {
  saveVersioned(LS_MODE, 1, next);
  setTreeMode(next);
}
function setMode(id: string, m: TreeMode) {
  persist({ ...treeMode(), [id]: m });
  setUserToggled((s) => new Set(s).add(id));
}
// collapsed/temp → filtered, recursively for the whole subtree (so the running
// paths expand all the way down).
function cascadeFiltered(id: string) {
  const next = { ...treeMode() };
  const stack = [id];
  let guard = 0;
  while (stack.length && guard++ < 100000) {
    const cur = stack.pop()!;
    next[cur] = "filtered";
    for (const c of Object.values(state.sessions)) if (c.parentID === cur) stack.push(c.id);
  }
  persist(next);
  setUserToggled((s) => new Set(s).add(id));
}
// Click behaviour keyed off the EFFECTIVE display state:
//   collapsed | temp → filtered (+cascade); filtered → expanded; expanded → collapsed
function onTwisty(id: string, d: DisplayState) {
  if (d === "collapsed" || d === "temp") cascadeFiltered(id);
  else if (d === "filtered") setMode(id, "expanded");
  else setMode(id, "collapsed");
}

// Strict ancestors (parent chain) of the active session.
function selectedAncestors(): Set<string> {
  const set = new Set<string>();
  let cur = selectedId() ? state.sessions[selectedId()!]?.parentID : undefined;
  let guard = 0;
  while (cur && guard++ < 100000) {
    set.add(cur);
    cur = state.sessions[cur]?.parentID;
  }
  return set;
}

// Ids whose SUBTREE is running (self busy/retry, or any descendant is) — built
// once per render by propagating busy sessions up their parent chain, so the
// tree doesn't do a subtree walk per node.
function buildWorkingSet(): Set<string> {
  const set = new Set<string>();
  // NOTE: index each value (state.activity[id]) rather than Object.entries() —
  // a Solid store's entries/values track only the KEY SET, not value changes, so
  // Object.entries would recompute only when a session is added/removed (e.g. a
  // new subsession) and miss a session simply flipping busy↔idle. Reading via the
  // proxy get-trap subscribes to each value, so live status updates land.
  for (const id of Object.keys(state.activity)) {
    const act = state.activity[id];
    if (act === "busy" || act === "retry") set.add(id);
  }
  for (const id of [...set]) {
    let cur = state.sessions[id]?.parentID;
    while (cur && !set.has(cur)) {
      set.add(cur);
      cur = state.sessions[cur]?.parentID;
    }
  }
  return set;
}

function Node(props: {
  session: Session;
  depth: number;
  prefix: boolean[];
  isLast: boolean;
  index: () => Record<string, Session[]>;
  ancestors: () => Set<string>;
  working: (id: string) => boolean;
}) {
  const kids = () => props.index()[props.session.id] || [];
  const activity = () => state.activity[props.session.id] || "idle";
  const busy = () => props.working(props.session.id);
  // Subtree has a pending permission/question awaiting a typed reply. Reactive —
  // clears itself the moment the request is answered.
  const needsInput = () => sessionNeedsInput(props.session.id);
  // Detailed line-2 stats: running/idle across ALL direct children (not just
  // hidden ones — this is an always-on summary, unlike the expand-state footer).
  const runCount = () => kids().filter((c) => props.working(c.id)).length;
  const idleCount = () => kids().length - runCount();
  // How long the session ran (created → last updated). Only meaningful once the
  // session has FINISHED (see the !busy() guard at the render site); empty when
  // unknown or sub-second so we don't print "ran for 0s".
  const ranFor = () => {
    const c = props.session.time?.created;
    const u = props.session.time?.updated;
    if (!c || !u || u <= c) return "";
    const span = u - c;
    // Seconds wouldn't tick live (the line isn't a live timer), so a stale "8s"
    // reads as wrong — collapse anything under a minute to "<1m".
    return span < 60_000 ? "<1m" : formatDuration(span);
  };

  const display = (): DisplayState => {
    const id = props.session.id;
    const m = modeOf(id);
    // An ancestor of the active session that would otherwise hide the path is
    // temporarily revealed (to just the path child).
    if (m !== "expanded" && props.ancestors().has(id) && !userToggled().has(id)) return "temp";
    return m;
  };

  // The single direct child on the path to the active session (for temp).
  const pathChild = (): Session | undefined => {
    const active = selectedId();
    return kids().find((c) => c.id === active || props.ancestors().has(c.id));
  };

  const visibleKids = (): Session[] => {
    const k = kids();
    switch (display()) {
      case "collapsed":
        return [];
      case "filtered":
        return k.filter((c) => props.working(c.id));
      case "temp": {
        const p = pathChild();
        return p ? [p] : [];
      }
      default: {
        // expanded: running children first, idle after (recency kept within each).
        const running = k.filter((c) => props.working(c.id));
        const idle = k.filter((c) => !props.working(c.id));
        return [...running, ...idle];
      }
    }
  };

  // Counts of HIDDEN direct children (running/idle) for the footer.
  const hidden = (): { running: number; idle: number } => {
    const k = kids();
    let running = 0;
    let idle = 0;
    for (const c of k) (props.working(c.id) ? running++ : idle++);
    switch (display()) {
      case "collapsed":
        return { running, idle }; // all hidden
      case "filtered":
        return { running: 0, idle }; // running shown, idle hidden
      case "temp": {
        const p = pathChild();
        if (p) props.working(p.id) ? running-- : idle--;
        return { running: Math.max(0, running), idle: Math.max(0, idle) };
      }
      default:
        return { running: 0, idle: 0 }; // expanded: nothing hidden
    }
  };

  const childPrefix = () => (props.depth === 0 ? [] : [...props.prefix, !props.isLast]);
  // In detailed density the node's own second line already shows the
  // running/idle counts, so the separate footer row would just duplicate them.
  const hasFooter = () =>
    treeDensity() !== "detailed" && kids().length > 0 && hidden().running + hidden().idle > 0;

  return (
    <>
      <div class="tree-row" classList={{ selected: selectedId() === props.session.id }}>
        <span class="tree-guides" aria-hidden="true">
          <For each={props.prefix}>{(rail) => <span class="tg-cell" classList={{ rail }} />}</For>
          <Show when={props.depth > 0}>
            <span class="tg-cell tg-connector" classList={{ last: props.isLast }} />
          </Show>
        </span>
        <button
          type="button"
          class="tree-twisty"
          classList={{ leaf: kids().length === 0 }}
          aria-label={`Subtree: ${display()} (click to cycle)`}
          data-tip={`Subtree: ${display()}`}
          onClick={(e) => {
            e.stopPropagation();
            if (kids().length > 0) onTwisty(props.session.id, display());
          }}
        >
          <Show when={kids().length > 0}>
            {/* expanded=chevron-down, collapsed=chevron-right (rotated),
                filtered=funnel, temp=eye. */}
            <Switch>
              <Match when={display() === "filtered"}>
                <span class="twisty-running"><Icon name="filter" size={12} /></span>
              </Match>
              <Match when={display() === "temp"}>
                <span class="twisty-temp"><Icon name="eye" size={12} /></span>
              </Match>
              <Match when={true}>
                <span classList={{ open: display() === "expanded" }}><Icon name="chevronDown" size={13} /></span>
              </Match>
            </Switch>
          </Show>
        </button>
        <button
          type="button"
          class="tree-node"
          classList={{ selected: selectedId() === props.session.id, sub: props.depth > 0, running: busy(), detailed: treeDensity() === "detailed" }}
          onClick={() => openSessionChat(props.session.id)}
          data-session-id={props.session.id}
          data-tip={props.session.title || props.session.id}
          {...menuTriggers(() => props.session.id, () => props.session.title || props.session.id)}
        >
          <span class="tree-line1">
            <Show when={busy()}>
              <Spinner class="tree-spinner" />
            </Show>
            <Show when={!busy() && activity() === "error"}>
              <span class="dot error" data-tip="error" />
            </Show>
            {/* Needs input: a pending permission/question (here or in a subagent)
                that's blocking until you reply. Takes visual priority. */}
            <Show when={needsInput()}>
              <span class="dot needs-input" data-tip="needs your input — reply to continue" />
            </Show>
            {/* Finished-unread: a root task that completed but hasn't been viewed. */}
            <Show when={!busy() && !needsInput() && state.unread[props.session.id]}>
              <span class="dot unread" data-tip="finished — not yet viewed" />
            </Show>
            <Show when={isPinned(props.session.id)}>
              <span class="dot pin" data-tip="pinned" />
            </Show>
            <span class="tree-title" classList={{ unread: !busy() && !!state.unread[props.session.id], "needs-input": needsInput() }}>
              {props.session.title || props.session.id}
            </span>
            <span class="tree-meta">
              <Show when={kids().length > 0}>
                <span class="tree-count">{kids().length}</span>
              </Show>
              <RelTime class="tree-time" ms={props.session.time?.updated || props.session.time?.created} />
            </span>
          </span>
          {/* Detailed mode: a second line. Direct-children running/idle counts
              when there are any, else the session's own facts (started + tokens). */}
          <Show when={treeDensity() === "detailed"}>
            <span class="tree-sub">
              <Show
                when={kids().length > 0}
                fallback={
                  <span class="tree-sub-started">
                    started <RelTime mode="ago" ms={props.session.time?.created} />
                    {/* Only for a FINISHED session: while it's still running,
                        "ran for" (created→last-event) lags behind "started ago"
                        and reads as wrong, so omit it. */}
                    <Show when={!busy() && ranFor()}>{`, ran for ${ranFor()}`}</Show>
                  </span>
                }
              >
                <Show when={runCount() > 0}>
                  <span class="tree-sub-run">{runCount()} running</span>
                </Show>
                <Show when={idleCount() > 0}>
                  <span class="tree-sub-idle">{idleCount()} idle</span>
                </Show>
              </Show>
            </span>
          </Show>
        </button>
      </div>

      <For each={visibleKids()}>
        {(child, i) => (
          <Node
            session={child}
            depth={props.depth + 1}
            prefix={childPrefix()}
            isLast={!hasFooter() && i() === visibleKids().length - 1}
            index={props.index}
            ancestors={props.ancestors}
            working={props.working}
          />
        )}
      </For>

      {/* Footer: what's hidden here (running/idle of direct children). */}
      <Show when={hasFooter()}>
        <div class="tree-row tree-footer-row">
          <span class="tree-guides" aria-hidden="true">
            <For each={childPrefix()}>{(rail) => <span class="tg-cell" classList={{ rail }} />}</For>
            <span class="tg-cell tg-connector last" />
          </span>
          {/* A line that stretches across the row, pushing the hidden-counts to
              the right (so the footer reads as a continuation of this branch). */}
          <span class="tree-footer-rule" aria-hidden="true" />
          <span class="tree-footer">
            <Show when={hidden().running > 0}>
              <span class="tree-footer-run">{hidden().running} running</span>
            </Show>
            <Show when={hidden().idle > 0}>
              <span class="tree-footer-idle">{hidden().idle} idle</span>
            </Show>
          </span>
        </div>
      </Show>
    </>
  );
}

export default function SessionTree() {
  const working = createMemo(() => buildWorkingSet());
  const index = createMemo(() => buildChildrenIndex(state.sessions, (s) => working().has(s.id)));
  const roots = () => index()[""] || [];
  const ancestors = createMemo(() => selectedAncestors());
  const isWorking = (id: string) => working().has(id);
  // Selecting a different session reverts temporary auto-expansions: clear the
  // manual-toggle overrides so the new path reveals fresh and the previous one
  // returns to its persisted state.
  createEffect(() => {
    selectedId();
    setUserToggled(new Set<string>());
  });
  // Auto-tidy as work starts/stops: a collapsed node that starts running opens
  // to filtered (surfaces the active work); a filtered node that goes idle
  // collapses (nothing left to show). Expanded nodes are left alone.
  let prevWorking = new Set<string>();
  createEffect(() => {
    const w = working();
    // Read current modes (so a concurrent manual toggle isn't clobbered). The
    // prevWorking guard makes a re-run from our own persist a no-op, so this
    // can't loop.
    const modes = treeMode();
    const next = { ...modes };
    let changed = false;
    for (const id of w) {
      if (!prevWorking.has(id) && (modes[id] ?? "filtered") === "collapsed") {
        next[id] = "filtered";
        changed = true;
      }
    }
    for (const id of prevWorking) {
      if (!w.has(id) && (modes[id] ?? "filtered") === "filtered") {
        next[id] = "collapsed";
        changed = true;
      }
    }
    prevWorking = new Set(w);
    if (changed) persist(next);
  });
  // Pinned roots float to the top (stable within each group).
  const sortedRoots = createMemo(() => {
    const r = roots();
    const pin = r.filter((s) => isPinned(s.id));
    return pin.length ? [...pin, ...r.filter((s) => !isPinned(s.id))] : r;
  });
  // Search collapses the tree into a flat, recency-sorted list of title matches
  // across the whole project (pinned first) — "find a session", not navigate.
  const results = createMemo(() => {
    const q = searchQuery().trim().toLowerCase();
    if (!q) return null;
    return Object.values(state.sessions)
      .filter((s) => (s.title || s.id).toLowerCase().includes(q))
      .sort((a, b) => {
        const pa = isPinned(a.id) ? 1 : 0, pb = isPinned(b.id) ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return (b.time?.updated || b.time?.created || 0) - (a.time?.updated || a.time?.created || 0);
      });
  });
  return (
    <div class="tree">
      <Show
        when={!results()}
        fallback={
          <Show when={results()!.length > 0} fallback={<div class="tree-empty">No matches</div>}>
            <For each={results()!}>
              {(s) => (
                <div class="tree-row" classList={{ selected: selectedId() === s.id }}>
                  <button
                    type="button"
                    class="tree-node"
                    classList={{ selected: selectedId() === s.id, running: isWorking(s.id), detailed: treeDensity() === "detailed" }}
                    onClick={() => openSessionChat(s.id)}
                    data-session-id={s.id}
                    data-tip={s.title || s.id}
                    {...menuTriggers(() => s.id, () => s.title || s.id)}
                  >
                    <span class="tree-line1">
                      <Show when={isWorking(s.id)}><Spinner class="tree-spinner" /></Show>
                      <Show when={sessionNeedsInput(s.id)}>
                        <span class="dot needs-input" data-tip="needs your input — reply to continue" />
                      </Show>
                      <Show when={isPinned(s.id)}><span class="dot pin" data-tip="pinned" /></Show>
                      <span class="tree-title" classList={{ "needs-input": sessionNeedsInput(s.id) }}>{s.title || s.id}</span>
                      <span class="tree-meta">
                        <RelTime class="tree-time" ms={s.time?.updated || s.time?.created} />
                      </span>
                    </span>
                  </button>
                </div>
              )}
            </For>
          </Show>
        }
      >
        <Show when={sortedRoots().length > 0} fallback={<div class="tree-empty">No sessions yet</div>}>
          <For each={sortedRoots()}>
            {(s, i) => (
              <Node
                session={s}
                depth={0}
                prefix={[]}
                isLast={i() === sortedRoots().length - 1}
                index={index}
                ancestors={ancestors}
                working={isWorking}
              />
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}
