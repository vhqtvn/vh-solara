import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { chooseModel, type ModelRef, pickerModels, recentModels, selectionFor } from "../models";
import Icon from "./Icon";

function Badges(props: { m: ModelRef }) {
  return (
    <span class="m-badges">
      <Show when={props.m.reasoning}>
        <span class="badge b-reason">reasoning</span>
      </Show>
      <Show when={props.m.vision}>
        <span class="badge b-vision">vision</span>
      </Show>
      <Show when={props.m.free}>
        <span class="badge b-free">free</span>
      </Show>
      <Show when={props.m.contextK}>
        <span class="badge">{props.m.contextK}k</span>
      </Show>
      <Show when={props.m.status && props.m.status !== "active"}>
        <span class="badge b-status">{props.m.status}</span>
      </Show>
    </span>
  );
}

function ModelRow(props: { m: ModelRef; selected: boolean; showProvider?: boolean; onPick: () => void }) {
  return (
    <button type="button" class="m-row" classList={{ selected: props.selected }} onClick={props.onPick}>
      <span class="m-row-main">
        <span class="m-name">{props.m.name}</span>
        {/* Grouped rows are already under a provider header, so the provider
            line is only shown for the ungrouped "Recent" list. */}
        <Show when={props.showProvider}>
          <span class="m-prov">{props.m.provider}</span>
        </Show>
      </span>
      <Badges m={props.m} />
      <Show when={props.selected}>
        <span class="m-check">✓</span>
      </Show>
    </button>
  );
}

// Searchable, recents-first, provider-grouped model picker with capability/cost
// badges. Full-screen on narrow (mobile) screens; a centered modal otherwise.
export default function ModelDialog(props: { sessionId: string; onClose: () => void }) {
  const [q, setQ] = createSignal("");
  const sel = () => selectionFor(props.sessionId);
  const isSel = (m: ModelRef) => sel()?.providerID === m.providerID && sel()?.modelID === m.modelID;

  const match = (m: ModelRef) => {
    const s = q().toLowerCase().trim();
    return !s || (m.name + " " + m.provider + " " + m.modelID).toLowerCase().includes(s);
  };
  const recents = createMemo(() => recentModels().filter(match));
  const groups = createMemo(() => {
    const g: Record<string, ModelRef[]> = {};
    for (const m of pickerModels().filter(match)) (g[m.provider] ||= []).push(m);
    return Object.entries(g).sort((a, b) => a[0].localeCompare(b[0]));
  });
  const empty = () => groups().length === 0;

  const pick = (m: ModelRef) => {
    chooseModel(props.sessionId, m.providerID, m.modelID);
    props.onClose();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  return (
    <div class="dialog-overlay" onClick={props.onClose}>
      <div class="dialog" role="dialog" aria-label="Select model" onClick={(e) => e.stopPropagation()}>
        <div class="dialog-head">
          <input
            class="dialog-search"
            placeholder="Search models…"
            value={q()}
            onInput={(e) => setQ(e.currentTarget.value)}
            autofocus
          />
          <button type="button" class="icon-btn" aria-label="Close" onClick={props.onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div class="dialog-body">
          <Show when={recents().length > 0}>
            <div class="m-group-label">Recent</div>
            <For each={recents()}>
              {(m) => <ModelRow m={m} selected={isSel(m)} showProvider onPick={() => pick(m)} />}
            </For>
          </Show>
          <For each={groups()}>
            {([prov, ms]) => (
              <>
                <div class="m-group-label">{prov}</div>
                <For each={ms}>{(m) => <ModelRow m={m} selected={isSel(m)} onPick={() => pick(m)} />}</For>
              </>
            )}
          </For>
          <Show when={empty()}>
            <div class="placeholder">No models match.</div>
          </Show>
        </div>
      </div>
    </div>
  );
}
