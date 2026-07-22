import { For, Show } from "solid-js";
import { selectedId, state } from "../sync";
import { lazyExpandBranch, collapseBranch } from "../sync";
import { displayName } from "../projectSettings";
import type { CollapsedBranchStub, Session } from "../types";
import Icon from "./Icon";
import Spinner from "./Spinner";
import RelTime from "./RelTime";

// Lazy import of Node + openSessionChat from SessionTree breaks the circular
// import (SessionTree imports StubNode, StubNode imports back from SessionTree).
// In ESM with SolidJS, this is safe: both bindings are function references
// resolved by live-binding, and they are only CALLED at render/event time
// (inside JSX / an onClick), never at module-eval time, so there's no TDZ. This
// mirrors the existing Node import precedent; openSessionChat follows it.
import { Node, openSessionChat } from "./SessionTree";

// StubNode — renders a collapsed-branch stub from the Phase 4 projection.
//
// A stub represents an idle (or recently-idle) subtree that the server did NOT
// materialize into full sessions. The stub carries aggregate facts
// (descendantCount, aggregateState, newestActivityAt) so the UI can show a
// meaningful summary row without the per-session data.
//
// Expand/collapse uses state.expandedBranches[id] (binary, NOT the 3-state
// treeMode that sessions use). Expanding triggers a lazy-expand fetch
// (lazyExpandBranch → GET /vh/sessions/branch) which materializes the stub's
// children into state.sessions; once materialized, this StubNode renders them
// as full <Node> rows alongside any nested stubs.
//
// StubNode receives the same index/ancestors/working props as Node so it can
// pass them through to materialized session children.

function StubNode(props: {
  stub: CollapsedBranchStub;
  depth: number;
  prefix: boolean[];
  isLast: boolean;
  index: () => Record<string, Session[]>;
  ancestors: () => Set<string>;
  working: (id: string) => boolean;
}) {
  const expanded = () => !!state.expandedBranches[props.stub.id];

  // Aggregate state → visual indicator. busy shows a spinner (actively working
  // underneath); retry/needs-input get priority dots; recent/idle get the
  // default muted appearance.
  const isBusy = () => props.stub.aggregateState === "busy";
  const isRetry = () => props.stub.aggregateState === "retry";
  const needsInput = () => props.stub.aggregateState === "needs-input";

  // Materialized session children (from the lazy-expand fetch). The index is
  // built from state.sessions, so after lazyExpandBranch(id) these land here.
  const sessionKids = () => props.index()[props.stub.id] || [];
  // Nested stub children (grandchildren that are themselves collapsed). These
  // come from state.branchStubs, not state.sessions.
  // Dedup invariant (stub-vs-session): suppress a stub whose own id is a live,
  // materialized session — see the matching guard in SessionTree. The
  // materialized <Node> always wins.
  const stubKids = () =>
    Object.values(state.branchStubs).filter(
      (s) => s.parentID === props.stub.id && !state.sessions[s.id],
    );

  const totalKids = () => sessionKids().length + stubKids().length;

  const childPrefix = () => (props.depth === 0 ? [] : [...props.prefix, !props.isLast]);

  const onTwisty = () => {
    if (expanded()) collapseBranch(props.stub.id);
    else lazyExpandBranch(props.stub.id);
  };

  return (
    <>
      <div class="tree-row tree-stub">
        <span class="tree-guides" aria-hidden="true">
          <For each={props.prefix}>{(rail) => <span class="tg-cell" classList={{ rail }} />}</For>
          <Show when={props.depth > 0}>
            <span class="tg-cell tg-connector" classList={{ last: props.isLast }} />
          </Show>
        </span>
        <button
          type="button"
          class="tree-twisty"
          classList={{ leaf: !props.stub.hasChildren }}
          aria-label={expanded() ? "Collapse branch" : "Expand branch"}
          data-tip={expanded() ? "Collapse" : "Expand (lazy-fetch)"}
          onClick={(e) => {
            e.stopPropagation();
            onTwisty();
          }}
        >
          <Show when={props.stub.hasChildren}>
            <span classList={{ open: expanded() }}>
              <Icon name="chevronDown" size={13} />
            </span>
          </Show>
        </button>
        <button
          type="button"
          class="tree-node tree-stub-node"
          classList={{
            sub: props.depth > 0,
            running: isBusy(),
            selected: selectedId() === props.stub.id,
          }}
          onClick={(e) => {
            e.stopPropagation();
            openSessionChat(props.stub.id);
          }}
          data-stub-id={props.stub.id}
          data-tip={"Open: " + displayName(props.stub.title || props.stub.id)}
        >
          <span class="tree-line1">
            <Show when={isBusy()}>
              <Spinner class="tree-spinner" />
            </Show>
            <Show when={!isBusy() && isRetry()}>
              <span class="dot retry" data-tip="retrying" />
            </Show>
            <Show when={needsInput()}>
              <span class="dot needs-input" data-tip="needs your input — reply to continue" />
            </Show>
            {/* Stubs never carry an AgentChip: the server omitted per-session
                agent data for collapsed subtrees. */}
            <span class="tree-title tree-stub-title">
              {displayName(props.stub.title || props.stub.id)}
            </span>
            <span class="tree-meta">
              <Show when={props.stub.descendantCount > 0}>
                <span class="tree-count tree-stub-count" data-tip={`${props.stub.descendantCount} sessions in this collapsed branch`}>
                  {props.stub.descendantCount}
                </span>
              </Show>
              <RelTime class="tree-time" ms={props.stub.newestActivityAt} />
            </span>
          </span>
        </button>
      </div>

      {/* Expanded children: materialized sessions (via <Node>) + nested stubs
          (via <StubNode>). Sessions come from the index (built from
          state.sessions after lazyExpandBranch materialized them); stubs come
          from state.branchStubs. */}
      <Show when={expanded()}>
        <For each={sessionKids()}>
          {(child, i) => (
            <Node
              session={child}
              depth={props.depth + 1}
              prefix={childPrefix()}
              isLast={i() === totalKids() - 1}
              index={props.index}
              ancestors={props.ancestors}
              working={props.working}
            />
          )}
        </For>
        <For each={stubKids()}>
          {(child, i) => (
            <StubNode
              stub={child}
              depth={props.depth + 1}
              prefix={childPrefix()}
              isLast={sessionKids().length + i() === totalKids() - 1}
              index={props.index}
              ancestors={props.ancestors}
              working={props.working}
            />
          )}
        </For>
      </Show>
    </>
  );
}

export default StubNode;
