// Per-project preferences editor. Reads/writes the display-only overlay
// .vh-solara/preferences.local.jsonc (via /vh/project-settings), which is
// gitignored so personal UI prefs never dirty the committed project.jsonc.
//
// Two sections share one screen-level Reload/Save:
//  1. Session names — ordered regex text-replacement rules applied to session
//     titles for DISPLAY ONLY (search/copy/rename/export/archive keep raw).
//  2. Agent styles — a per-agent label + theme-color + chip-style picker.
//
// Save shows a confirm diff of the actual file change before writing; Reload
// re-reads from disk (handling a missing/just-deleted file gracefully). Both
// sections send their payload together on save (the PUT is key-presence-aware,
// so a combined write is safe); dirty-editor protection against an SSE nudge
// keeps unsaved edits per-section.
import { createEffect, createMemo, createSignal, For, Index, on, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { agents } from "../agents";
import { state } from "../sync";
import { projectDir } from "../sync";
import { renderDiff } from "../render";
import {
  AGENT_CHIP_STYLES,
  AGENT_COLOR_OPTIONS,
  agentStylesRaw,
  colorVar,
  refreshProjectSettings,
  nameReplacements,
  compileNameReplacements,
  applyNameReplacements,
  compileNameReplacementErrors,
  type NameReplacementRule,
} from "../projectSettings";
import Select from "./Select";
import Icon from "./Icon";
import styles from "./PreferencesView.module.css";

interface Row {
  label: string;
  color: string;
  style: string;
}

export default function PreferencesView() {
  // --- Agent-styles section state (carried over from the former editor) ---
  const [rows, setRows] = createStore<Record<string, Row>>({});

  // --- Session-names section state ---
  // Draft rules edited locally; seeded from the saved overlay. Always a fresh
  // array identity on each edit so SolidJS reactivity fires per-row.
  const [nameRules, setNameRules] = createSignal<NameReplacementRule[]>([]);
  // Editable sample raw title for the preview box.
  const [sampleTitle, setSampleTitle] = createSignal("[[IMPORTANT]] release");

  // --- Shared screen state ---
  const [diff, setDiff] = createSignal<{
    html: string;
    payload: { agentStyles: Record<string, any>; nameReplacements: NameReplacementRule[] };
  } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [msg, setMsg] = createSignal<string>("");

  // Agent-styles: a row for every live agent plus any agent named only in the
  // file (so a style for a since-removed agent stays editable/removable).
  const names = createMemo(() => {
    const set = new Set<string>([...agents().map((a) => a.name), ...Object.keys(agentStylesRaw())]);
    return [...set].sort();
  });

  // Per-section baselines (JSON of each as last seeded from disk) → drive dirty,
  // so a live external change knows whether it can safely reseed or must defer
  // to unsaved edits.
  let agentBaseline = "{}";
  let namesBaseline = "[]";
  const agentDirty = () => JSON.stringify(rows) !== agentBaseline;
  const namesDirty = () => JSON.stringify(nameRules()) !== namesBaseline;
  const dirty = () => agentDirty() || namesDirty();

  // (Re)seed BOTH editable sections from what's currently loaded from disk.
  function seed() {
    // Agent styles
    const raw = agentStylesRaw();
    const next: Record<string, Row> = {};
    for (const n of names()) {
      const r = (raw[n] || {}) as any;
      next[n] = { label: r.label || "", color: r.color || "", style: r.style || "soft" };
    }
    setRows(reconcile(next));
    agentBaseline = JSON.stringify(next);
    // Session names — clone the saved rules into an editable draft, normalizing
    // each entry to {pattern, replacement, flags?}.
    const saved = nameReplacements();
    const draftRules: NameReplacementRule[] = saved.map((r) => {
      const out: NameReplacementRule = {
        pattern: typeof r.pattern === "string" ? r.pattern : "",
        replacement: typeof r.replacement === "string" ? r.replacement : "",
      };
      if (typeof r.flags === "string" && r.flags !== "") out.flags = r.flags;
      return out;
    });
    setNameRules(draftRules);
    namesBaseline = JSON.stringify(draftRules);
  }

  async function reload() {
    setMsg("");
    await refreshProjectSettings();
    seed();
  }
  onMount(reload);

  // The overlay changed on disk (the live watch re-read it). If neither section
  // has unsaved edits, reflect it immediately; otherwise leave the work alone
  // and point the user at Reload. Watches both underlying signals.
  createEffect(
    on([agentStylesRaw, nameReplacements], () => {
      if (!dirty()) seed();
      else setMsg("Config changed on disk — Reload to load it.");
    }, { defer: true }),
  );

  // --- Session-names row operations (immutable edits → fresh array identity) ---
  function addRule() {
    setNameRules((prev) => [...prev, { pattern: "", replacement: "" }]);
  }
  function updateRule(i: number, field: "pattern" | "replacement" | "flags", value: string) {
    setNameRules((prev) =>
      prev.map((r, idx) => {
        if (idx !== i) return r;
        if (field === "flags") {
          // Keep flags field present while editing; trimmed/omitted on save.
          const next: NameReplacementRule = { pattern: r.pattern, replacement: r.replacement };
          if (value !== "") next.flags = value;
          return next;
        }
        return { ...r, [field]: value };
      }),
    );
  }
  function removeRule(i: number) {
    setNameRules((prev) => prev.filter((_, idx) => idx !== i));
  }
  function moveRule(i: number, dir: -1 | 1) {
    setNameRules((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      const tmp = next[i];
      next[i] = next[j];
      next[j] = tmp;
      return next;
    });
  }

  // Per-row validation on the DRAFT rules (compile is fail-soft; invalid rules
  // are flagged but never block saving the rest). Indexed by original position.
  const nameErrors = createMemo(() => compileNameReplacementErrors(nameRules()));

  // Preview: compile the DRAFT pipeline once per render-storm and apply it to
  // the editable sample + a bounded list of current project session titles.
  const previewCompiled = createMemo(() => compileNameReplacements(nameRules()));
  const previewDisplay = (raw: string): string => applyNameReplacements(previewCompiled(), raw);
  // Bounded list of real session titles (most-recent first, capped to keep the
  // preview short). Falls back gracefully when no sessions exist.
  const sessionTitles = createMemo(() =>
    Object.values(state.sessions)
      .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
      .slice(0, 8)
      .map((s) => s.title || s.id),
  );

  // Build the combined payload: agentStyles (only styled agents) + the ordered
  // nameReplacements array. Both keys are always supplied; the PUT is
  // key-presence-aware so a combined write is safe.
  function payload(): { agentStyles: Record<string, any>; nameReplacements: NameReplacementRule[] } {
    const agentOut: Record<string, any> = {};
    for (const [name, r] of Object.entries(rows)) {
      const label = r.label.trim().slice(0, 6);
      if (!label && !r.color) continue;
      const e: any = { style: r.style || "soft" };
      if (label) e.label = label;
      if (r.color) e.color = r.color;
      agentOut[name] = e;
    }
    const namesOut: NameReplacementRule[] = nameRules().map((r) => {
      const out: NameReplacementRule = {
        pattern: typeof r.pattern === "string" ? r.pattern : "",
        replacement: typeof r.replacement === "string" ? r.replacement : "",
      };
      // Omit flags when empty (matches the Go `flags,omitempty` shape).
      if (typeof r.flags === "string" && r.flags.trim() !== "") out.flags = r.flags.trim();
      return out;
    });
    return { agentStyles: agentOut, nameReplacements: namesOut };
  }

  const colorOpts = [
    { value: "", label: "Default", swatch: "var(--fg-dim)" },
    ...AGENT_COLOR_OPTIONS.map((c) => ({ value: c.name, label: c.name, swatch: c.var })),
  ];
  const styleOpts = AGENT_CHIP_STYLES.map((s) => ({ value: s, label: s }));

  // Dry-run the combined payload: the server returns the {old,new} file text
  // without writing; render the diff and stash the captured payload for commit.
  async function preview() {
    setBusy(true);
    setMsg("");
    try {
      const p = payload();
      const res = await fetch(`/vh/project-settings?dir=${encodeURIComponent(projectDir())}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentStyles: p.agentStyles, nameReplacements: p.nameReplacements, dryRun: true }),
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
      const html = await renderDiff(".vh-solara/preferences.local.jsonc", old, nw);
      setDiff({ html, payload: p });
    } finally {
      setBusy(false);
    }
  }

  // Commit the captured payload (the exact object the user saw diffed).
  async function commit() {
    const d = diff();
    if (!d) return;
    setBusy(true);
    try {
      const res = await fetch(`/vh/project-settings?dir=${encodeURIComponent(projectDir())}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentStyles: d.payload.agentStyles, nameReplacements: d.payload.nameReplacements }),
      });
      if (!res.ok) {
        setMsg("Save failed.");
        return;
      }
      setDiff(null);
      await reload();
      setMsg("Saved to .vh-solara/preferences.local.jsonc.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="agents-editor">
      <div class="agents-head">
        <div>
          <h2 class="agents-title">Preferences</h2>
          <p class="agents-sub">
            Per-project — saved to <code>.vh-solara/preferences.local.jsonc</code> — local, gitignored. The committed{" "}
            <code>project.jsonc</code> is never touched.
          </p>
        </div>
        <div class="agents-actions">
          <button type="button" class="btn" onClick={reload} disabled={busy()} data-tip="Re-read the file from disk">
            <Icon name="retry" size={14} />Reload
          </button>
          <button type="button" class="btn btn-primary" onClick={preview} disabled={busy()}>
            Save…
          </button>
        </div>
      </div>

      <Show when={msg()}>
        <div class="agents-msg">{msg()}</div>
      </Show>

      {/* ── Session names ─────────────────────────────────────────────── */}
      <section class={styles.namesSection}>
        <h3 class={styles.sectionTitle}>Session names</h3>
        <p class={styles.sectionSub}>
          Ordered regex rules applied to session titles for <strong>display only</strong>. Rules apply in order (each
          rule sees the previous rule's output). Search, copy, rename, export, and archive always keep the original
          title.
        </p>

        <div class={styles.rulesHead}>
          <span>Pattern</span>
          <span>Replacement</span>
          <span>Flags</span>
          <span>{/* actions */}</span>
          <span>{/* error */}</span>
        </div>
        <Index each={nameRules()}>
          {(rule, i) => (
            <div class={styles.ruleRow} classList={{ [styles.ruleInvalid]: !!nameErrors()[i] }}>
              <input
                class={styles.rulePattern}
                type="text"
                placeholder="\[\[IMPORTANT\]\]"
                value={rule().pattern ?? ""}
                onInput={(e) => updateRule(i, "pattern", e.currentTarget.value)}
                spellcheck={false}
              />
              <input
                class={styles.ruleReplacement}
                type="text"
                placeholder="❗"
                value={rule().replacement ?? ""}
                onInput={(e) => updateRule(i, "replacement", e.currentTarget.value)}
              />
              <input
                class={styles.ruleFlags}
                type="text"
                placeholder="g"
                value={rule().flags ?? ""}
                onInput={(e) => updateRule(i, "flags", e.currentTarget.value)}
                spellcheck={false}
              />
              <span class={styles.ruleActions}>
                <button
                  type="button"
                  class={styles.ruleBtn}
                  onClick={() => moveRule(i, -1)}
                  disabled={i === 0}
                  aria-label="Move rule up"
                  title="Move up"
                >
                  <Icon name="arrowUp" size={14} />
                </button>
                <button
                  type="button"
                  class={styles.ruleBtn}
                  onClick={() => moveRule(i, 1)}
                  disabled={i === nameRules().length - 1}
                  aria-label="Move rule down"
                  title="Move down"
                >
                  <Icon name="arrowDown" size={14} />
                </button>
                <button
                  type="button"
                  class={styles.ruleBtn}
                  onClick={() => removeRule(i)}
                  aria-label="Remove rule"
                  title="Remove"
                >
                  <Icon name="x" size={14} />
                </button>
              </span>
              <Show when={nameErrors()[i]}>
                <span class={styles.ruleError}>
                  ⚠ {nameErrors()[i]} — Ignored until fixed
                </span>
              </Show>
            </div>
          )}
        </Index>
        <button type="button" class={styles.addRule} onClick={addRule}>
          <Icon name="plus" size={14} /> Add rule
        </button>

        {/* Preview: editable sample + live current session titles (raw → displayed) */}
        <div class={styles.preview}>
          <div class={styles.previewSample}>
            <label class={styles.previewLabel} for="pref-name-sample">
              Sample title
            </label>
            <input
              id="pref-name-sample"
              class={styles.previewInput}
              type="text"
              value={sampleTitle()}
              onInput={(e) => setSampleTitle(e.currentTarget.value)}
            />
            <span class={styles.previewArrow}>→</span>
            <strong class={styles.previewResult}>{previewDisplay(sampleTitle())}</strong>
          </div>
          <Show when={sessionTitles().length > 0}>
            <div class={styles.previewSessions}>
              <For each={sessionTitles()}>
                {(t) => (
                  <div class={styles.previewSessionRow}>
                    <code class={styles.previewRaw}>{t}</code>
                    <span class={styles.previewArrow}>→</span>
                    <span class={styles.previewShown}>{previewDisplay(t)}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </section>

      {/* ── Agent styles (carried over) ───────────────────────────────── */}
      <section class="agents-rows">
        <h3 class={styles.sectionTitle}>Agent styles</h3>
        <p class={styles.sectionSub}>
          Give an agent a label and a theme color so it stands apart in the picker and on its messages.
        </p>
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
      </section>

      <Show when={diff()}>
        <div class="agents-modal-scrim" onClick={() => setDiff(null)}>
          <div class="agents-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Confirm changes</h3>
            <p class="agents-sub">
              This writes <code>.vh-solara/preferences.local.jsonc</code> (local, gitignored). Comments and the rest of
              the file are kept; the committed <code>project.jsonc</code> is never touched.
            </p>
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
