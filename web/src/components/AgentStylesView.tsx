// Per-project agent-styles editor. Reads/writes the display-only `agentStyles`
// block of THIS project's .vh-solara/project.jsonc (via /vh/project-settings).
// No JSON typing: a row per agent with a label, a theme-color picker (swatches,
// never a raw color), a chip-style choice, and a live preview. Save shows a
// confirm diff of the actual file change before writing; Reload re-reads from
// disk (handling a missing/just-deleted file gracefully).
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { agents } from "../agents";
import { projectDir } from "../sync";
import { renderDiff } from "../render";
import {
  AGENT_CHIP_STYLES,
  AGENT_COLOR_OPTIONS,
  agentStylesRaw,
  colorVar,
  refreshProjectSettings,
} from "../projectSettings";
import Select from "./Select";
import Icon from "./Icon";

interface Row {
  label: string;
  color: string;
  style: string;
}

export default function AgentStylesView() {
  const [rows, setRows] = createStore<Record<string, Row>>({});
  const [diff, setDiff] = createSignal<{ html: string; payload: Record<string, any> } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [msg, setMsg] = createSignal<string>("");

  // Show a row for every live agent plus any agent named only in the file (so a
  // style for a since-removed agent stays editable/removable).
  const names = createMemo(() => {
    const set = new Set<string>([...agents().map((a) => a.name), ...Object.keys(agentStylesRaw())]);
    return [...set].sort();
  });

  // (Re)seed the editable rows from what's currently loaded from disk.
  function seed() {
    const raw = agentStylesRaw();
    const next: Record<string, Row> = {};
    for (const n of names()) {
      const r = (raw[n] || {}) as any;
      next[n] = { label: r.label || "", color: r.color || "", style: r.style || "soft" };
    }
    setRows(reconcile(next));
  }

  async function reload() {
    setMsg("");
    await refreshProjectSettings();
    seed();
  }
  onMount(reload);

  // Build the agentStyles object to persist: only agents the user actually
  // styled (a label or a color); style rides along only when styled.
  function payload(): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [name, r] of Object.entries(rows)) {
      const label = r.label.trim().slice(0, 6);
      if (!label && !r.color) continue;
      const e: any = { style: r.style || "soft" };
      if (label) e.label = label;
      if (r.color) e.color = r.color;
      out[name] = e;
    }
    return out;
  }

  const colorOpts = [
    { value: "", label: "Default", swatch: "var(--fg-dim)" },
    ...AGENT_COLOR_OPTIONS.map((c) => ({ value: c.name, label: c.name, swatch: c.var })),
  ];
  const styleOpts = AGENT_CHIP_STYLES.map((s) => ({ value: s, label: s }));

  async function preview() {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(`/vh/project-settings?dir=${encodeURIComponent(projectDir())}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentStyles: payload(), dryRun: true }),
      });
      if (!res.ok) {
        setMsg("Could not read the project config.");
        return;
      }
      const { old, new: nw } = (await res.json()) as { old: string; new: string };
      if (old === nw) {
        setMsg("No changes to save.");
        return;
      }
      const html = await renderDiff(".vh-solara/project.jsonc", old, nw);
      setDiff({ html, payload: payload() });
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    const d = diff();
    if (!d) return;
    setBusy(true);
    try {
      const res = await fetch(`/vh/project-settings?dir=${encodeURIComponent(projectDir())}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentStyles: d.payload }),
      });
      if (!res.ok) {
        setMsg("Save failed.");
        return;
      }
      setDiff(null);
      await reload();
      setMsg("Saved to .vh-solara/project.jsonc.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="agents-editor">
      <div class="agents-head">
        <div>
          <h2 class="agents-title">Agent styles</h2>
          <p class="agents-sub">
            Per-project — saved to <code>.vh-solara/project.jsonc</code>. Give an agent a label and a
            theme color so it stands apart in the picker and on its messages.
          </p>
        </div>
        <div class="agents-actions">
          <button type="button" class="btn" onClick={reload} disabled={busy()} data-tip="Re-read the file from disk">
            <Icon name="retry" size={14} /> Reload
          </button>
          <button type="button" class="btn btn-primary" onClick={preview} disabled={busy()}>
            Save…
          </button>
        </div>
      </div>

      <Show when={msg()}>
        <div class="agents-msg">{msg()}</div>
      </Show>

      <div class="agents-rows">
        <div class="agents-row agents-row-head">
          <span>Agent</span>
          <span>Label</span>
          <span>Color</span>
          <span>Style</span>
          <span>Preview</span>
        </div>
        <For each={names()}>
          {(name) => {
            const r = () => rows[name];
            const styled = () => !!(r()?.label.trim() || r()?.color);
            return (
              <div class="agents-row">
                <span class="agents-name">@{name}</span>
                <input
                  class="agents-label"
                  type="text"
                  maxLength={6}
                  placeholder="—"
                  value={r()?.label ?? ""}
                  onInput={(e) => setRows(name, "label", e.currentTarget.value)}
                />
                <Select
                  class="agents-color"
                  ariaLabel={`${name} color`}
                  value={r()?.color ?? ""}
                  options={colorOpts}
                  onChange={(v) => setRows(name, "color", v)}
                />
                <Select
                  class="agents-style"
                  ariaLabel={`${name} style`}
                  value={r()?.style ?? "soft"}
                  options={styleOpts}
                  onChange={(v) => setRows(name, "style", v)}
                />
                <span class="agents-preview">
                  <span
                    class="msg-agent"
                    classList={{ styled: styled() }}
                    data-chip={r()?.style}
                    style={styled() && r()?.color ? { "--agent-color": colorVar(r()!.color) } : undefined}
                  >
                    {r()?.label.trim() || `@${name}`}
                  </span>
                </span>
              </div>
            );
          }}
        </For>
      </div>

      <Show when={diff()}>
        <div class="agents-modal-scrim" onClick={() => setDiff(null)}>
          <div class="agents-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Confirm changes</h3>
            <p class="agents-sub">This writes <code>.vh-solara/project.jsonc</code>. Comments and the rest of the file are kept.</p>
            <div class="agents-diff vh-diff" innerHTML={diff()!.html} />
            <div class="agents-modal-actions">
              <button type="button" class="btn" onClick={() => setDiff(null)} disabled={busy()}>
                Cancel
              </button>
              <button type="button" class="btn btn-primary" onClick={commit} disabled={busy()}>
                Save to file
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
