import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import {
  buildSummary,
  fmtBytes,
  fmtBytesPctiles,
  fmtCountStats,
  fmtNum,
  fmtPctiles,
  type DiagSnapshot,
  type Histogram,
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

const ENDPOINT = "/vh/diag/latency";
const AUTO_REFRESH_MS = 2000;

export default function PerformanceDialog(props: { onClose: () => void }) {
  const [snap, setSnap] = createSignal<DiagSnapshot | null>(null);
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
        return;
      }
      const text = await r.text();
      setRaw(text);
      try {
        setSnap(JSON.parse(text) as DiagSnapshot);
      } catch {
        setError("invalid JSON response");
        setSnap(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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

  // Copy summary: the compact human-readable digest built by perfFormat. Falls
  // back to the readonly textarea. The summary is staged into fallbackText —
  // NOT raw() — so the verbatim server response (the source of truth for a
  // later "Copy JSON") stays intact.
  async function copySummary() {
    const s = snap();
    if (!s) return;
    const text = buildSummary(s);
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
                disabled={!snap()}
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
                <Show when={snap()} fallback={<div class={styles.loading}>{loading() ? "Loading…" : "(no data)"}</div>}>
                  {(s) => <Body snap={s()} />}
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

function Body(props: { snap: DiagSnapshot }) {
  const p = props.snap.probes;
  return (
    <div class={styles.body}>
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
    </div>
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
