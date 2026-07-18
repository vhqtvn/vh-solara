import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import {
  buildAggregatedSummary,
  buildSummary,
  fmtBytes,
  fmtBytesPctiles,
  fmtCountStats,
  fmtNum,
  fmtPctiles,
  parseDiagView,
  type AggregatedDiag,
  type DiagSnapshot,
  type DiagView,
  type Histogram,
  type WorkerInfo,
} from "../lib/perfFormat";
import { modal } from "../lib/a11y";
import Icon from "./Icon";
import styles from "./PerformanceDialog.module.css";

// Opt-in Performance diagnostics viewer. Reached from the server-admin menu's
// Diagnostics section, and only when the user has enabled it in Settings →
// General (default OFF — a normal user never sees this surface).
//
// The server-side probes are ALWAYS on. Most hot-path aggregations are
// atomic/lock-free (see pkg/diagnostics/primitives.go + pkg/state/store.go
// emit path); the tunnel write path additionally samples a lock-free global
// active-stream gauge per write and defers the only per-session yamux
// NumStreams() read to threshold-gated (≥100ms) slow-write incidents (see
// pkg/tunnel/websocket.go). This dialog is the missing VIEW + COPY surface:
// on open it fetches GET /vh/diag/latency (a bounded JSON snapshot — no
// transcript/session/URL content), renders it scannably, and offers
// "Copy JSON" (verbatim) and "Copy summary" (compact human-readable digest)
// for pasting into a bug report.
//
// Overhead contract: strictly on-demand. No polling by default. An opt-in
// per-dialog "auto-refresh 2s" toggle exists for live diagnosis, OFF on open.
// Closing the dialog tears down the timer. No work happens in the streaming
// path because of this dialog.
//
// TOPOLOGY: the dialog is project-decoupled — it lives at the app root via
// the global perfDiagOpen signal (ui.ts) so switching projects never re-fetches
// or re-mounts it. The single /vh/diag/latency endpoint serves two shapes
// depending on which process the browser is talking to:
//   • Controller topology: GET returns an AGGREGATED envelope — the
//     controller's own snapshot + one snapshot per connected worker (keyed by
//     worker ID), plus a failures map for workers that errored/timed out
//     during fan-out, plus worker_info for human labels. The route is
//     served by the controller's own aggregator even on per-worker
//     subdomains (hostInterceptor carve-out — see pkg/server/daemon.go).
//   • Direct topology (browser → worker, no controller): the worker serves
//     its own snapshot in the LEGACY single-entity shape (started_at_ns +
//     probes). The dialog detects the shape via the `workers` key (see
//     isAggregated in perfFormat) and renders the single-entity view as a
//     fallback — exactly the pre-aggregation behavior, so a direct-worker
//     deployment is unchanged.

const ENDPOINT = "/vh/diag/latency";
const AUTO_REFRESH_MS = 2000;

export default function PerformanceDialog(props: { onClose: () => void }) {
  // view() holds the parsed topology-aware view-model. The discriminant
  // `kind` selects the rendering branch — "single" (direct topology) renders
  // one entity; "aggregated" (controller) renders controller + per-worker.
  const [view, setView] = createSignal<DiagView | null>(null);
  const [raw, setRaw] = createSignal<string>("");
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [autoRefresh, setAutoRefresh] = createSignal(false);
  const [copied, setCopied] = createSignal<null | "json" | "summary">(null);
  // fallbackText holds whatever text is currently staged into the off-screen
  // copy-fallback textarea (the select-all path for browsers without the async
  // clipboard). It is SEPARATE from raw(): raw() is the IMMUTABLE verbatim
  // server response and must never be overwritten by a summary (otherwise a
  // later "Copy JSON" would copy the summary instead — the F1 regression).
  const [fallbackText, setFallbackText] = createSignal<string>("");
  let timer: ReturnType<typeof setInterval> | undefined;
  let copyFlashTimer: ReturnType<typeof setTimeout> | undefined;
  let rawRef: HTMLTextAreaElement | undefined;

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(ENDPOINT, { headers: { "X-VH-CSRF": "1" } });
      if (!r.ok) {
        setError(`HTTP ${r.status}`);
        setView(null);
        return;
      }
      const text = await r.text();
      setRaw(text);
      try {
        // parseDiagView sniffs the response shape (aggregated envelope vs
        // single snapshot) and returns the matching view-model. Throws on
        // invalid JSON or unrecognized shape → "invalid JSON response" error.
        setView(parseDiagView(text));
      } catch {
        setError("invalid JSON response");
        setView(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setView(null);
    } finally {
      setLoading(false);
    }
  }

  // Initial fetch on mount.
  onMount(() => {
    void refresh();
  });

  // Auto-refresh toggle: only poll when explicitly enabled. The timer callback
  // skips a tick while a fetch is already in flight (loading()) so a slow or
  // hung endpoint can't accumulate overlapping requests — each cadence tick is
  // a no-op until the previous refresh settles.
  function applyAuto(on: boolean) {
    setAutoRefresh(on);
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    if (on) {
      timer = setInterval(() => {
        if (!loading()) void refresh();
      }, AUTO_REFRESH_MS);
    }
  }
  onCleanup(() => {
    if (timer !== undefined) clearInterval(timer);
    if (copyFlashTimer !== undefined) clearTimeout(copyFlashTimer);
  });

  // Escape to close.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  function flash(kind: "json" | "summary") {
    setCopied(kind);
    if (copyFlashTimer !== undefined) clearTimeout(copyFlashTimer);
    copyFlashTimer = setTimeout(() => setCopied(null), 1400);
  }

  // Copy JSON: the full verbatim response text. Falls back to selecting the
  // readonly textarea (e.g. older mobile browsers without the async clipboard).
  // The textarea is staged with the RAW response (never a summary) so even via
  // the fallback path the operator copies exactly what the server returned.
  async function copyJson() {
    const text = raw() || "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      flash("json");
      return;
    } catch {
      /* fall through to fallback */
    }
    if (rawRef) {
      setFallbackText(text);
      queueMicrotask(() => {
        rawRef?.focus();
        rawRef?.select();
      });
    }
  }

  // Copy summary: the compact human-readable digest built by perfFormat. For
  // the aggregated topology this spans controller + every worker; for the
  // single topology it is the original single-snapshot digest. Falls back to
  // the readonly textarea. The summary is staged into fallbackText — NOT
  // raw() — so the verbatim server response (the source of truth for a later
  // "Copy JSON") stays intact (the F1 invariant).
  async function copySummary() {
    const v = view();
    if (!v) return;
    const text =
      v.kind === "aggregated" ? buildAggregatedSummary(v.agg) : buildSummary(v.snap);
    try {
      await navigator.clipboard.writeText(text);
      flash("summary");
      return;
    } catch {
      /* fall through to fallback */
    }
    if (rawRef) {
      setFallbackText(text);
      queueMicrotask(() => {
        rawRef?.focus();
        rawRef?.select();
      });
    }
  }

  return (
    <Portal>
      <div class="dialog-overlay" onClick={props.onClose}>
        <div
          use:modal
          class="dialog"
          role="dialog"
          aria-label="Performance diagnostics"
          aria-modal="true"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="dialog-head">
            <span class="dialog-title">
              <Icon name="cpu" size={15} /> Performance
            </span>
            <button type="button" class="icon-btn" aria-label="Close" onClick={props.onClose}>
              <Icon name="x" size={14} />
            </button>
          </div>

          <div class="dialog-body">
            <div class={styles.toolbar}>
              <label class={styles.toggle}>
                <input
                  type="checkbox"
                  checked={autoRefresh()}
                  onChange={(e) => applyAuto(e.currentTarget.checked)}
                />
                <span>Auto-refresh 2s</span>
              </label>
              <div class={styles.spacer} />
              <button
                type="button"
                class={styles.btn}
                onClick={() => void refresh()}
                disabled={loading()}
              >
                <Icon name="retry" size={13} />
                {loading() ? "Loading…" : "Refresh"}
              </button>
              <button
                type="button"
                class={styles.btn}
                onClick={copySummary}
                disabled={!view()}
                title="Copy a compact human-readable digest"
              >
                <Icon name="clipboard" size={13} />
                Copy summary
              </button>
              <button
                type="button"
                class={styles.btn}
                onClick={copyJson}
                disabled={!raw()}
                title="Copy the full raw JSON response"
              >
                <Icon name="copy" size={13} />
                Copy JSON
              </button>
              <Show when={copied()}>
                <span class={styles.copied}>
                  <Icon name="check" size={12} /> Copied {copied()}
                </span>
              </Show>
            </div>

            <Show
              when={error()}
              fallback={
                <Show when={view()} fallback={<div class={styles.loading}>{loading() ? "Loading…" : "(no data)"}</div>}>
                  {(v) => <Body view={v()} />}
                </Show>
              }
            >
              <div class={styles.err}>
                Couldn't load diagnostics: {error()}. <button type="button" class={styles.retryInline} onClick={() => void refresh()}>Retry</button>
              </div>
            </Show>

            {/* Hidden readonly textarea is BOTH the copy fallback (select-all
                on clipboard failure) and a staging area for whichever text is
                being copied (raw JSON or the summary digest). Kept off-screen,
                not display:none, so .select() works. The value is fallbackText
                when a copy fallback has staged something, otherwise the raw
                verbatim response; raw() itself is never mutated by a summary
                copy (see the F1 invariant on fallbackText). */}
            <textarea
              ref={rawRef}
              class={styles.rawarea}
              readOnly
              aria-hidden="true"
              tabIndex={-1}
              value={fallbackText() || raw()}
            />
          </div>
        </div>
      </div>
    </Portal>
  );
}

// ── Body rendering ───────────────────────────────────────────────────────────
// The body is intentionally sectioned so each probe reads as its own card.
// We avoid a raw-JSON dump: numbers are human-formatted, percentiles are
// labeled p50/p95/p99, and the latency-attribution discriminators the operator
// cares about (yamux write-by-direction, ws_write mutex_wait vs write_msg) are
// given their own rows rather than collapsed into a generic histogram table.
//
// Topology dispatch: Body takes the topology-aware view-model and renders
// either a single SnapshotBody (direct topology) or an AggregatedBody
// (controller topology). The diagnostic VALUE of the aggregated view is
// per-worker detail — we deliberately DO NOT collapse workers into sums,
// because "which worker is slow" is the question the operator is asking.

function Body(props: { view: DiagView }) {
  // Plain if-branch: the parent <Show when={view()}>{(v) => <Body view={v()} />}</Show>
  // uses the keyed-callback form, which re-creates Body whenever view() changes
  // by reference (every refresh). So this discriminant read is re-evaluated
  // fresh each refresh — no stale-branch risk. (Routing through <Show> here
  // would lose TS's flow-narrowing of the discriminated union.)
  if (props.view.kind === "single") {
    return <SnapshotBody snap={props.view.snap} />;
  }
  return <AggregatedBody agg={props.view.agg} />;
}

// AggregatedBody renders the controller section first, then one section per
// worker (in stable ID-sorted order so two successive snapshots diff cleanly).
// Failures are surfaced as a small reason list near the top so a worker that
// errored or timed out during fan-out is visible without scrolling through
// every healthy worker's body. The aggregated body does NOT collapse worker
// data — each worker keeps its full SnapshotBody so the operator can compare
// per-worker latency attribution.
function AggregatedBody(props: { agg: AggregatedDiag }) {
  const workerIds = () => Object.keys(props.agg.workers ?? {}).sort();
  const failureEntries = () => Object.entries(props.agg.failures ?? {});
  return (
    <div class={styles.body}>
      <Show when={failureEntries().length > 0}>
        <section class={`${styles.section} ${styles.failSection}`}>
          <h3 class={styles.sectionTitle}>
            Unreachable workers · {failureEntries().length}
          </h3>
          <For each={failureEntries()}>
            {([id, reason]) => (
              <div class={styles.rowline}>
                <span class={styles.statLabel}>{id}</span>
                <span class={styles.mono}>{reason}</span>
              </div>
            )}
          </For>
        </section>
      </Show>

      <Show
        when={props.agg.controller}
        fallback={
          <section class={styles.section}>
            <h3 class={styles.sectionTitle}>Controller</h3>
            <div class={styles.rowline}>
              <span class={styles.mono}>(controller snapshot unavailable)</span>
            </div>
          </section>
        }
      >
        <EntityGroup title="Controller" snap={props.agg.controller as DiagSnapshot} />
      </Show>

      <For each={workerIds()}>
        {(id) => (
          <EntityGroup
            title={entityTitle("Worker", id, props.agg.worker_info?.[id])}
            snap={props.agg.workers[id]}
          />
        )}
      </For>
    </div>
  );
}

// EntityGroup wraps one entity's SnapshotBody with a clear visual header so
// the operator sees entity boundaries when scanning the dialog. The header
// surfaces the worker name + id when available (worker_info); the SnapshotBody
// renders the full per-probe card stack.
function EntityGroup(props: { title: string; snap: DiagSnapshot }) {
  return (
    <div class={styles.entityGroup}>
      <h3 class={styles.entityTitle}>{props.title}</h3>
      <SnapshotBody snap={props.snap} />
    </div>
  );
}

function entityTitle(label: string, id?: string, info?: WorkerInfo): string {
  if (info?.name && id) return `${label} · ${info.name} (${id})`;
  if (id) return `${label} (${id})`;
  return label;
}

function SnapshotBody(props: { snap: DiagSnapshot }) {
  const p = props.snap.probes;
  return (
    <>
      <Section title="Ingest">
        <Stat label="events" value={fmtNum(props.snap.probes.ingest.events)} />
        <Stat label="bytes" value={fmtBytes(props.snap.probes.ingest.bytes)} />
        <HistRow label="dispatch duration" h={p.ingest.dispatch_dur} />
        <HistRow label="bytes histogram" h={p.ingest.bytes_hist} format={fmtBytesPctiles} />
      </Section>

      <Section title="Emit">
        <MapRow label="class count" m={p.emit.class_count} />
        <MapRow label="class bytes" m={p.emit.class_bytes} fmt={fmtBytes} />
        <MapRow label="source count" m={p.emit.source_count} />
        <HistRow label="emit age" h={p.emit.emit_age} />
        <Stat label="subscriber drops" value={fmtNum(p.emit.subscriber_drops)} />
      </Section>

      <For each={p.stream}>
        {(s) => (
          <Section title={`Stream · ${s.class}`}>
            <div class={styles.rowline}>
              <Stat label="opens" value={fmtNum(s.opens)} />
              <Stat label="writes" value={fmtNum(s.writes)} />
              <Stat label="flushes" value={fmtNum(s.flushes)} />
              <Stat label="write errors" value={fmtNum(s.write_errors)} />
              <Stat label="bytes" value={fmtBytes(s.bytes)} />
            </div>
            <HistRow label="write duration" h={s.write_dur} />
            <HistRow label="flush duration" h={s.flush_dur} />
            <HistRow label="interarrival" h={s.interarrival} />
            <div class={styles.rowline}>
              <Stat label="snapshot path" value={fmtNum(s.snapshot_path)} />
              <Stat label="snapshot bytes" value={fmtBytes(s.snapshot_bytes)} />
              <Stat label="replay path" value={fmtNum(s.replay_path)} />
            </div>
            <MapRow label="disconnect reason" m={s.disc_reason} />
            <IncidentRow label="slow writes" n={s.slow_writes?.length ?? 0} />
            <IncidentRow label="slow flushes" n={s.slow_flushes?.length ?? 0} />
          </Section>
        )}
      </For>

      <Section title="Yamux">
        <div class={styles.rowline}>
          <Stat label="active streams" value={fmtNum(p.yamux.active_streams)} />
          <Stat label="opened" value={fmtNum(p.yamux.streams_opened)} />
          <Stat label="open fails" value={fmtNum(p.yamux.stream_open_fails)} />
          <Stat label="bytes read" value={fmtBytes(p.yamux.bytes_read)} />
        </div>
        <HistRow label="open duration" h={p.yamux.open_dur} />
        <div class={styles.subhead}>write by direction (response vs request — SSE attribution)</div>
        <For each={p.yamux.write_by_dir}>
          {(wd) => (
            <div class={styles.sub}>
              <div class={styles.sublabel}>{wd.dir}</div>
              <div class={styles.rowline}>
                <Stat label="bytes" value={fmtBytes(wd.bytes)} />
                <Stat label="slow writes" value={fmtNum(wd.slow_writes)} />
                <Stat label="incidents" value={fmtNum(wd.slow_write_incidents?.length ?? 0)} />
              </div>
              <HistRow label="duration" h={wd.dur} />
            </div>
          )}
        </For>
        <MapRow label="close reason" m={p.yamux.close_reason} />
      </Section>

      <For each={p.ws_write}>
        {(w) => (
          <Section title={`WebSocket write · ${w.side}`}>
            <div class={styles.rowline}>
              <Stat label="bytes" value={fmtBytes(w.bytes)} />
              <Stat label="writes" value={fmtNum(w.writes)} />
              <Stat label="errors" value={fmtNum(w.errors)} />
            </div>
            <div class={styles.subhead}>mutex wait vs write message (HOL vs bandwidth)</div>
            <HistRow label="mutex wait" h={w.mutex_wait_dur} />
            <HistRow label="write message" h={w.write_msg_dur} />
            <HistRow label="total" h={w.total_dur} />
            <HistRow label="active streams at write" h={w.active_streams_at_write} format={fmtCountStats} />
            <IncidentRow label="slow write incidents" n={w.slow_write_incidents?.length ?? 0} />
          </Section>
        )}
      </For>

      <For each={p.copy}>
        {(c) => (
          <Section title={`Copy · ${c.dir}`}>
            <Stat label="bytes" value={fmtBytes(c.bytes)} />
            <HistRow label="duration" h={c.dur} />
            <MapRow label="termination" m={c.term} />
          </Section>
        )}
      </For>
    </>
  );
}

function Section(props: { title: string; children: any }) {
  return (
    <section class={styles.section}>
      <h3 class={styles.sectionTitle}>{props.title}</h3>
      {props.children}
    </section>
  );
}

function Stat(props: { label: string; value: string }) {
  return (
    <div class={styles.stat}>
      <span class={styles.statLabel}>{props.label}</span>
      <span class={styles.statValue}>{props.value}</span>
    </div>
  );
}

function HistRow(props: {
  label: string;
  h: Histogram | undefined | null;
  // format renders the histogram's value string. Defaults to fmtPctiles
  // (duration percentiles). Pass fmtBytesPctiles for byte-size histograms
  // (bytes_hist) and fmtCountStats for count histograms
  // (active_streams_at_write) so neither is misrendered through the duration
  // formatter — see the F2 fix in perfFormat.ts.
  format?: (h: Histogram) => string;
}) {
  const empty = () => !props.h || props.h.count <= 0;
  const fmt = props.format ?? fmtPctiles;
  return (
    <div class={styles.rowline}>
      <span class={styles.statLabel}>{props.label}</span>
      <span class={styles.mono}>{empty() ? "—" : fmt(props.h as Histogram)}</span>
    </div>
  );
}

function MapRow(props: { label: string; m: Record<string, number>; fmt?: (n: number) => string }) {
  const fmt = props.fmt ?? fmtNum;
  const entries = () => Object.entries(props.m ?? {}).filter(([, v]) => v > 0);
  return (
    <div class={styles.rowline}>
      <span class={styles.statLabel}>{props.label}</span>
      <span class={styles.mono}>
        {entries().length === 0 ? "—" : entries().map(([k, v]) => `${k}=${fmt(v)}`).join("  ·  ")}
      </span>
    </div>
  );
}

function IncidentRow(props: { label: string; n: number }) {
  return (
    <div class={styles.rowline}>
      <span class={styles.statLabel}>{props.label}</span>
      <span class={styles.mono}>{fmtNum(props.n)}</span>
    </div>
  );
}
