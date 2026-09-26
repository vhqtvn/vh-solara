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

  // Browser back closes the dialog (mobile/PWA posture); Esc and the overlay
  // click close it too. The admin menu stays mounted behind (its dismiss
  // guard reads fleetOpen, which stays true until the menu unmounts us).
  useBackEntry(props.onClose, "fleetcfg");
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
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
                          spellcheck={false}
                          aria-label={`Worker ${i + 1} id`}
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
                          spellcheck={false}
                          aria-label={`Project ${i + 1} dir`}
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
