import { createMemo, createSignal, Index, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { useBackEntry } from "../lib/backStack";
import { modal } from "../lib/a11y";
import Icon from "./Icon";
import styles from "./FleetStatusDialog.module.css";

// Fleet-status config editor (slice C2 of the fleet-status config redesign;
// server side landed in pkg/server/status_config.go — GET/PUT /vh/fleet/config).
// Reached from the hidden server-admin menu (right-click / long-press Settings
// → VH Solara Server → "Fleet status"), the operator-confirmed home for this
// pane. Manages the EXPECTED worker/project rosters the fleet status page
// rolls up: workers (id + optional display label) and projects (dir + optional
// label).
//
// Wire contract (mirror of pkg/server/status_config.go):
//   GET /vh/fleet/config → {schema, writable, workers:[{id,label?}],
//                          projects:[{dir,label?}]} — the effective config.
//   PUT /vh/fleet/config → body is the FILE schema only: {workers, projects}.
//     (schema/writable are response-only — sending them would trip the
//     server's strict DisallowUnknownFields decode with a 400.)
//     Refusal ladder: 403 CSRF (installCsrf() adds the header app-wide; we
//     also set it explicitly so the pane works in isolated/test contexts),
//     409 writable:false (no --status-config on the server — render the
//     read-only posture + off-hint), 400 validation error (body carries the
//     precise message — surface verbatim, never a client-side guess).
//     200 → the effective config; we re-GET anyway so the pane reflects the
//     persisted state exactly as the server serves it (labels echo back).
//
// Client validation MIRRORS the server rules for immediate per-row feedback
// (invalid/blank worker id charset, duplicate ids, blank/whitespace-only dir,
// duplicate dir by exact verbatim equality, label > 64 code points) — UX sugar
// only; the server response is always the authority.
//
// Like OpenCodeUpdateDialog / RestartOpenCodeDialog, this is portaled to
// <body> and lifted above the admin popup (z 60) via var(--z-modal); the
// admin menu stays mounted behind it (its dismiss guard knows about us).

interface WorkerRow {
  id: string;
  label: string;
}
interface ProjectRow {
  dir: string;
  label: string;
}

interface FleetConfigResponse {
  schema?: number;
  writable?: boolean;
  workers?: { id?: string; label?: string }[];
  projects?: { dir?: string; label?: string }[];
}

// Mirror of pkg/server buildFleetOptions (GET /vh/fleet/config/options):
// the add-row picker feed derived from the current rollup generation.
// workers[].status: rollup statuses (ok|offline|missing|timeout|error|
// limited) plus "online" (registry-connected worker outside the expected
// roster — the prime add candidate). projects[].workers: hosting worker ids.
interface FleetOptionsResponse {
  schema?: number;
  generated_at?: string;
  workers?: { id?: string; status?: string }[];
  projects?: { dir?: string; workers?: string[] }[];
}

// One picker suggestion: primary text (worker id / project dir), secondary
// hint (rollup status word / hosting workers), and a status-dot tier.
interface Sugg {
  main: string;
  sub: string;
  dot: "ok" | "warn" | "dim" | "";
}

const MAX_SUGGESTIONS = 8;

// Operator-friendly status hints for the worker picker's secondary line.
function workerStatusHint(status: string): string {
  switch (status) {
    case "ok":
      return "ok";
    case "online":
      return "connected — not in roster";
    case "offline":
      return "offline";
    case "missing":
      return "configured, not seen";
    case "timeout":
      return "acquisition timeout";
    case "error":
      return "acquisition error";
    case "limited":
      return "capped (limited)";
    default:
      return status;
  }
}

function workerDotTier(status: string): Sugg["dot"] {
  switch (status) {
    case "ok":
    case "online":
      return "ok";
    case "missing":
    case "timeout":
    case "error":
      return "warn";
    default:
      return "dim";
  }
}

const MAX_LABEL_CP = 64; // maxFleetConfigLabelRunes mirror (code points, not bytes)
// validWorkerHostLabel mirror: non-empty ASCII letters/digits/'.'/'_'/'-' only
// (the id is substituted into configured HostPattern deep links server-side).
const WORKER_ID_RE = /^[A-Za-z0-9._-]+$/;

function labelTooLong(s: string): boolean {
  return [...s].length > MAX_LABEL_CP;
}

// Parse a config response body defensively: a 200 whose body is NOT JSON
// (an HTML page or plain text — e.g. a misrouted proxy or the worker's SPA
// fallback) must surface as a clean, honest load error, never as a raw
// "JSON.parse: unexpected character …" exception message. Well-formed error
// paths are unaffected: non-2xx statuses short-circuit before this (the
// !r.ok branches), and 409/400 bodies are read as text elsewhere.
async function parseConfigResponse(r: Response): Promise<FleetConfigResponse> {
  const text = await r.text();
  try {
    return JSON.parse(text) as FleetConfigResponse;
  } catch {
    throw new Error(`Unexpected response from server (not JSON; HTTP ${r.status})`);
  }
}

// Per-row error strings indexed like the draft arrays; undefined = row OK.
// Mirrors validateStatusConfig: the LATER occurrence of a duplicate is the
// flagged one (the server reports workers[i]/projects[i] at the second index).
// Project dirs are VERBATIM — whitespace-only rejected, otherwise no trimming
// (exact-match authority, the landed normalizeProjectRoster semantics).
function validateWorkers(rows: WorkerRow[]): (string | undefined)[] {
  const errs: (string | undefined)[] = [];
  const seen = new Set<string>();
  rows.forEach((w, i) => {
    if (!w.id) {
      errs[i] = "worker id required";
    } else if (!WORKER_ID_RE.test(w.id)) {
      errs[i] = 'invalid worker id (allowed: letters, digits, ".", "_", "-")';
    } else if (seen.has(w.id)) {
      errs[i] = `duplicate worker id "${w.id}"`;
    } else {
      seen.add(w.id);
    }
    if (!errs[i] && labelTooLong(w.label)) {
      errs[i] = `label exceeds the ${MAX_LABEL_CP}-code-point limit`;
    }
  });
  return errs;
}

function validateProjects(rows: ProjectRow[]): (string | undefined)[] {
  const errs: (string | undefined)[] = [];
  const seen = new Set<string>();
  rows.forEach((p, i) => {
    if (p.dir.trim() === "") {
      errs[i] = "blank project dir (whitespace-only entries are rejected)";
    } else if (seen.has(p.dir)) {
      errs[i] = `duplicate project dir "${p.dir}"`;
    } else {
      seen.add(p.dir); // verbatim equality — no trimming on either side
    }
    if (!errs[i] && labelTooLong(p.label)) {
      errs[i] = `label exceeds the ${MAX_LABEL_CP}-code-point limit`;
    }
  });
  return errs;
}

export default function FleetStatusDialog(props: { onClose: () => void }) {
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [writable, setWritable] = createSignal(true);
  const [workers, setWorkers] = createSignal<WorkerRow[]>([]);
  const [projects, setProjects] = createSignal<ProjectRow[]>([]);
  const [saving, setSaving] = createSignal(false);
  const [serverError, setServerError] = createSignal<string | null>(null);
  const [savedAt, setSavedAt] = createSignal(0);

  const workerErrors = createMemo(() => validateWorkers(workers()));
  const projectErrors = createMemo(() => validateProjects(projects()));
  const clientValid = () =>
    workerErrors().every((e) => e === undefined) && projectErrors().every((e) => e === undefined);
  const saveDisabled = () => !writable() || loading() || saving() || !clientValid();

  function applyConfig(cfg: FleetConfigResponse) {
    setWritable(!!cfg.writable);
    setWorkers((cfg.workers ?? []).map((w) => ({ id: w.id ?? "", label: w.label ?? "" })));
    setProjects((cfg.projects ?? []).map((p) => ({ dir: p.dir ?? "", label: p.label ?? "" })));
  }

  async function load(): Promise<void> {
    setLoading(true);
    setLoadError(null);
    try {
      const r = await fetch("/vh/fleet/config");
      if (!r.ok) {
        setLoadError(`HTTP ${r.status}`);
        return;
      }
      applyConfig(await parseConfigResponse(r));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  onMount(() => void load());

  async function save(): Promise<void> {
    if (saveDisabled()) return;
    setSaving(true);
    setServerError(null);
    try {
      // File-schema body only; empty labels omitted (the server's omitempty
      // echo shape). No trimming of dirs — they are stored verbatim.
      const body = {
        workers: workers().map((w) => (w.label ? { id: w.id, label: w.label } : { id: w.id })),
        projects: projects().map((p) => (p.label ? { dir: p.dir, label: p.label } : { dir: p.dir })),
      };
      const r = await fetch("/vh/fleet/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
        body: JSON.stringify(body),
      });
      if (r.status === 409) {
        // Honest refusal: the server has no --status-config persistence path.
        // Flip to the read-only posture — the off-hint renders and Save
        // disables. The rosters stay visible (view-only) as loaded.
        setWritable(false);
        return;
      }
      if (!r.ok) {
        // 400 carries the server's precise validation message as plain text —
        // surface it verbatim (do not guess). Also catches 403/5xx.
        setServerError((await r.text()).trim() || `HTTP ${r.status}`);
        return;
      }
      await load(); // re-GET: reflect the persisted state (labels echo back)
      setSavedAt(Date.now());
    } catch (e) {
      setServerError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // --- Draft row operations (immutable edits → fresh array identity) -------
  const addWorker = () => setWorkers((p) => [...p, { id: "", label: "" }]);
  const addProject = () => setProjects((p) => [...p, { dir: "", label: "" }]);
  const setWorker = (i: number, field: "id" | "label", v: string) =>
    setWorkers((p) => p.map((w, idx) => (idx === i ? { ...w, [field]: v } : w)));
  const setProject = (i: number, field: "dir" | "label", v: string) =>
    setProjects((p) => p.map((row, idx) => (idx === i ? { ...row, [field]: v } : row)));
  const removeWorker = (i: number) => setWorkers((p) => p.filter((_, idx) => idx !== i));
  const removeProject = (i: number) => setProjects((p) => p.filter((_, idx) => idx !== i));

  // --- Add-from-fleet pickers (GET /vh/fleet/config/options) ---------------
  // Enhancement, NOT a dependency: the feed is fetched ONCE on open, beside
  // the config GET. Any failure just leaves the pickers suggestion-less (+
  // the subtle footer hint) — the free-typed flow is untouched, because
  // expected mode exists precisely to add things that are currently
  // down/absent, which by definition have no live suggestion.
  const [options, setOptions] = createSignal<FleetOptionsResponse | null>(null);
  const [optionsFailed, setOptionsFailed] = createSignal(false);

  async function loadOptions(): Promise<void> {
    try {
      const r = await fetch("/vh/fleet/config/options");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const parsed = JSON.parse(await r.text()) as FleetOptionsResponse;
      // Shape guard: a non-options JSON body (misroute/proxy fallback) must
      // degrade to "no suggestions", never render garbage rows.
      if (!Array.isArray(parsed?.workers) || !Array.isArray(parsed?.projects)) {
        throw new Error("unexpected options shape");
      }
      setOptions(parsed);
    } catch {
      setOptionsFailed(true);
    }
  }
  onMount(() => void loadOptions());

  const workerSugg = (q: string): Sugg[] =>
    (options()?.workers ?? [])
      .filter((w) => (w.id ?? "").toLowerCase().includes(q.trim().toLowerCase()))
      .slice(0, MAX_SUGGESTIONS)
      .map((w): Sugg => ({
        main: w.id ?? "",
        sub: workerStatusHint(w.status ?? ""),
        dot: workerDotTier(w.status ?? ""),
      }));

  const projectSugg = (q: string): Sugg[] =>
    (options()?.projects ?? [])
      .filter((p) => (p.dir ?? "").toLowerCase().includes(q.trim().toLowerCase()))
      .slice(0, MAX_SUGGESTIONS)
      .map((p): Sugg => ({
        main: p.dir ?? "",
        sub: (p.workers ?? []).length > 0 ? `on ${(p.workers ?? []).join(", ")}` : "",
        dot: "",
      }));

  // One open picker at a time (section + row index); pickIdx is the
  // keyboard-active suggestion (-1 = none). Reset on pick, blur, Escape, or
  // input. Suggestions render INLINE under the row (a full-width flex child,
  // like the row error line) — no portal, no fixed positioning, so nothing
  // can be clipped by the dialog-body scroll and the cost is plain blocks.
  const [openPick, setOpenPick] = createSignal<{ kind: "worker" | "project"; i: number } | null>(null);
  const [pickIdx, setPickIdx] = createSignal(-1);
  const isOpen = (kind: "worker" | "project", i: number) =>
    openPick()?.kind === kind && openPick()?.i === i;

  function pickSuggestion(kind: "worker" | "project", i: number, s: Sugg): void {
    if (kind === "worker") setWorker(i, "id", s.main);
    else setProject(i, "dir", s.main);
    setOpenPick(null);
    setPickIdx(-1);
  }

  const closePick = (kind: "worker" | "project", i: number) => {
    if (isOpen(kind, i)) {
      setOpenPick(null);
      setPickIdx(-1);
    }
  };

  // Keyboard: ↑/↓ cycle the active suggestion (opening a closed picker),
  // Enter picks the active one. Escape is deliberately NOT handled here:
  // Solid delegates keydown to the document root, so a stopPropagation in
  // this handler could not outrank the dialog's own document-level Escape
  // listener anyway — instead the dialog handler (onKey below) owns the
  // layering: one Escape closes an open picker, the next closes the dialog.
  function onPickKey(
    e: KeyboardEvent,
    kind: "worker" | "project",
    i: number,
    list: () => Sugg[],
  ): void {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
    const sugg = list();
    if (sugg.length === 0) return;
    if (e.key === "Enter") {
      const idx = pickIdx();
      if (isOpen(kind, i) && idx >= 0 && idx < sugg.length) {
        e.preventDefault();
        pickSuggestion(kind, i, sugg[idx]);
      }
      return;
    }
    e.preventDefault();
    if (!isOpen(kind, i)) {
      setOpenPick({ kind, i });
      setPickIdx(0);
      return;
    }
    const n = sugg.length;
    setPickIdx((p) => (e.key === "ArrowDown" ? (p + 1) % n : p <= 0 ? n - 1 : p - 1));
  }

  // Browser back closes the dialog (mobile/PWA posture); Esc and the overlay
  // click close it too. The admin menu stays mounted behind (its dismiss
  // guard reads fleetOpen, which stays true until the menu unmounts us).
  // Escape is LAYERED: an open suggestion picker closes first; only a second
  // Escape reaches the dialog itself.
  useBackEntry(props.onClose, "fleetcfg");
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (openPick()) {
        setOpenPick(null);
        setPickIdx(-1);
        return;
      }
      props.onClose();
    }
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  return (
    <Portal>
      <div class="dialog-overlay" classList={{ [styles.overlay]: true }} onClick={props.onClose}>
        <div
          use:modal
          class="dialog"
          classList={{ [styles.dialog]: true }}
          role="dialog"
          aria-label="Fleet status"
          aria-modal="true"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="dialog-head">
            <span class="dialog-title">
              <Icon name="layers" size={15} /> Fleet status
            </span>
            <button type="button" class="icon-btn" aria-label="Close" onClick={props.onClose}>
              <Icon name="x" size={14} />
            </button>
          </div>

          <div class="dialog-body">
            <Show when={loading()}>
              <div class={styles.status}>Loading…</div>
            </Show>
            <Show when={loadError()}>
              <div class={styles.err}>Couldn't load the fleet config ({loadError()}).</div>
              <button type="button" class="btn" onClick={() => void load()}>
                Retry
              </button>
            </Show>

            <Show when={!loading() && !loadError()}>
              <Show when={!writable()}>
                <div class={styles.off}>
                  Config management is off — start the server with <code>--status-config &lt;path&gt;</code>.
                  The current roster is shown read-only.
                </div>
              </Show>

              {/* ── Workers ─────────────────────────────────────────────── */}
              <section>
                <div class={styles.secHead}>
                  <h3 class={styles.secTitle}>Workers</h3>
                  <Show when={writable()}>
                    <button type="button" class={styles.addBtn} onClick={addWorker}>
                      <Icon name="plus" size={13} /> Add worker
                    </button>
                  </Show>
                </div>
                <Show when={workers().length === 0}>
                  <div class={styles.empty}>
                    No workers configured — the status page lists every connected worker (discovered
                    scope).
                  </div>
                </Show>
                <Index each={workers()}>
                  {(w, i) => (
                    <div class={styles.row} classList={{ [styles.rowBad]: !!workerErrors()[i] }}>
                      <Show
                        when={writable()}
                        fallback={
                          <>
                            <span class={styles.roMain}>{w().id}</span>
                            <Show when={w().label}>
                              <span class={styles.roLabel}>{w().label}</span>
                            </Show>
                          </>
                        }
                      >
                        <input
                          class={styles.inMain}
                          type="text"
                          placeholder="worker id (e.g. build-box)"
                          value={w().id}
                          onInput={(e) => setWorker(i, "id", e.currentTarget.value)}
                          onFocus={() => {
                            setOpenPick({ kind: "worker", i });
                            setPickIdx(-1);
                          }}
                          onBlur={() => closePick("worker", i)}
                          onKeyDown={(e) => onPickKey(e, "worker", i, () => workerSugg(w().id))}
                          spellcheck={false}
                          aria-label={`Worker ${i + 1} id`}
                          aria-autocomplete="list"
                          aria-expanded={isOpen("worker", i)}
                        />
                        <input
                          class={styles.inLabel}
                          type="text"
                          placeholder="label (optional)"
                          value={w().label}
                          onInput={(e) => setWorker(i, "label", e.currentTarget.value)}
                          aria-label={`Worker ${i + 1} label`}
                        />
                        <button
                          type="button"
                          class={styles.rm}
                          onClick={() => removeWorker(i)}
                          aria-label={`Remove worker ${i + 1}`}
                          title="Remove"
                        >
                          <Icon name="x" size={13} />
                        </button>
                        <Show when={isOpen("worker", i) && workerSugg(w().id).length > 0}>
                          <div class={styles.picks} role="listbox" aria-label={`Known workers (row ${i + 1})`}>
                            <Index each={workerSugg(w().id)}>
                              {(s, si) => (
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected={pickIdx() === si}
                                  class={styles.pick}
                                  classList={{ [styles.pickActive]: pickIdx() === si }}
                                  // Keep the input's focus so the click lands
                                  // before any blur-close could race it.
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => pickSuggestion("worker", i, s())}
                                >
                                  <span
                                    classList={{
                                      [styles.pickDot]: s().dot !== "",
                                      [styles.pickDotOk]: s().dot === "ok",
                                      [styles.pickDotWarn]: s().dot === "warn",
                                      [styles.pickDotDim]: s().dot === "dim",
                                    }}
                                    aria-hidden="true"
                                  />
                                  <span class={styles.pickMain}>{s().main}</span>
                                  <Show when={s().sub}>
                                    <span class={styles.pickSub}>{s().sub}</span>
                                  </Show>
                                </button>
                              )}
                            </Index>
                          </div>
                        </Show>
                      </Show>
                      <Show when={workerErrors()[i]}>
                        <span class={styles.rowErr}>⚠ {workerErrors()[i]}</span>
                      </Show>
                    </div>
                  )}
                </Index>
              </section>

              {/* ── Projects ────────────────────────────────────────────── */}
              <section>
                <div class={styles.secHead}>
                  <h3 class={styles.secTitle}>Projects</h3>
                  <Show when={writable()}>
                    <button type="button" class={styles.addBtn} onClick={addProject}>
                      <Icon name="plus" size={13} /> Add project
                    </button>
                  </Show>
                </div>
                <Show when={projects().length === 0}>
                  <div class={styles.empty}>
                    No projects configured — the status page lists every worker-reported project
                    (discovered scope).
                  </div>
                </Show>
                <Index each={projects()}>
                  {(p, i) => (
                    <div class={styles.row} classList={{ [styles.rowBad]: !!projectErrors()[i] }}>
                      <Show
                        when={writable()}
                        fallback={
                          <>
                            <span class={styles.roMain}>{p().dir}</span>
                            <Show when={p().label}>
                              <span class={styles.roLabel}>{p().label}</span>
                            </Show>
                          </>
                        }
                      >
                        <input
                          class={styles.inMain}
                          type="text"
                          placeholder="/path/to/project (verbatim)"
                          value={p().dir}
                          onInput={(e) => setProject(i, "dir", e.currentTarget.value)}
                          onFocus={() => {
                            setOpenPick({ kind: "project", i });
                            setPickIdx(-1);
                          }}
                          onBlur={() => closePick("project", i)}
                          onKeyDown={(e) => onPickKey(e, "project", i, () => projectSugg(p().dir))}
                          spellcheck={false}
                          aria-label={`Project ${i + 1} dir`}
                          aria-autocomplete="list"
                          aria-expanded={isOpen("project", i)}
                        />
                        <input
                          class={styles.inLabel}
                          type="text"
                          placeholder="label (optional)"
                          value={p().label}
                          onInput={(e) => setProject(i, "label", e.currentTarget.value)}
                          aria-label={`Project ${i + 1} label`}
                        />
                        <button
                          type="button"
                          class={styles.rm}
                          onClick={() => removeProject(i)}
                          aria-label={`Remove project ${i + 1}`}
                          title="Remove"
                        >
                          <Icon name="x" size={13} />
                        </button>
                        <Show when={isOpen("project", i) && projectSugg(p().dir).length > 0}>
                          <div class={styles.picks} role="listbox" aria-label={`Observed project dirs (row ${i + 1})`}>
                            <Index each={projectSugg(p().dir)}>
                              {(s, si) => (
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected={pickIdx() === si}
                                  class={styles.pick}
                                  classList={{ [styles.pickActive]: pickIdx() === si }}
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => pickSuggestion("project", i, s())}
                                >
                                  <span class={styles.pickMain}>{s().main}</span>
                                  <Show when={s().sub}>
                                    <span class={styles.pickSub}>{s().sub}</span>
                                  </Show>
                                </button>
                              )}
                            </Index>
                          </div>
                        </Show>
                      </Show>
                      <Show when={projectErrors()[i]}>
                        <span class={styles.rowErr}>⚠ {projectErrors()[i]}</span>
                      </Show>
                    </div>
                  )}
                </Index>
              </section>
            </Show>
          </div>

          <div class={styles.foot}>
            <Show when={serverError()}>
              <div class={styles.err}>{serverError()}</div>
            </Show>
            <Show when={savedAt() > 0 && !serverError()}>
              <div class={styles.ok}>✓ Saved</div>
            </Show>
            <div class={styles.footHint}>
              Saving rewrites the config file as JSON — hand-written comments are not kept.
              <Show when={optionsFailed()}>
                {" "}Live fleet suggestions are unavailable — type ids manually.
              </Show>
            </div>
            <div class={styles.footBtns}>
              <button type="button" class="btn" onClick={() => void load()} disabled={loading() || saving()}>
                <Icon name="retry" size={13} /> Reload
              </button>
              <button type="button" class="btn btn-primary" onClick={() => void save()} disabled={saveDisabled()}>
                {saving() ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Portal>
  );
}
