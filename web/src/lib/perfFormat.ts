// Formatting + summary helpers for the Performance diagnostics dialog.
//
// The dialog reads GET /vh/diag/latency, a bounded JSON snapshot of the
// always-on server-side probes (see pkg/diagnostics/handler.go). Every
// duration is an integer number of nanoseconds; bytes and counts are raw.
// These helpers turn those raw ns/byte numbers into human-readable strings
// for both the on-screen rendering and the "Copy summary" digest.
//
// Kept side-effect-free and DOM-free so it is unit-testable in the node
// vitest environment (no jsdom needed).

// ── Wire types (mirror pkg/diagnostics/handler.go snapshotJSON) ──────────────

export interface Histogram {
  count: number;
  sum_ns: number;
  min_ns: number;
  max_ns: number;
  p50_ns: number;
  p95_ns: number;
  p99_ns: number;
  avg_ns: number;
}

export interface Incident {
  at_ns: number;
  kind: string;
  bytes?: number;
  dur_ns: number;
  detail?: number;
  aux?: number;
}

export interface IngestProbe {
  events: number;
  bytes: number;
  dispatch_dur: Histogram;
  bytes_hist: Histogram;
}

export interface EmitProbe {
  class_count: Record<string, number>;
  class_bytes: Record<string, number>;
  source_count: Record<string, number>;
  emit_age: Histogram;
  subscriber_drops: number;
}

export interface StreamProbe {
  class: string;
  opens: number;
  bytes: number;
  writes: number;
  flushes: number;
  write_errors: number;
  write_dur: Histogram;
  flush_dur: Histogram;
  interarrival: Histogram;
  ping_dur: Histogram;
  snapshot_path: number;
  replay_path: number;
  snapshot_bytes: number;
  disc_reason: Record<string, number>;
  slow_writes: Incident[];
  slow_flushes: Incident[];
}

export interface YamuxWriteDir {
  dir: string;
  bytes: number;
  dur: Histogram;
  slow_writes: number;
  slow_write_incidents: Incident[];
}

export interface YamuxProbe {
  streams_opened: number;
  stream_open_fails: number;
  active_streams: number;
  open_dur: Histogram;
  bytes_read: number;
  write_by_dir: YamuxWriteDir[];
  close_reason: Record<string, number>;
}

export interface WsWriteSide {
  side: string;
  bytes: number;
  writes: number;
  errors: number;
  mutex_wait_dur: Histogram;
  write_msg_dur: Histogram;
  total_dur: Histogram;
  active_streams_at_write: Histogram;
  slow_write_incidents: Incident[];
}

export interface CopyDir {
  dir: string;
  bytes: number;
  dur: Histogram;
  term: Record<string, number>;
}

export interface DiagSnapshot {
  started_at_ns: number;
  probes: {
    ingest: IngestProbe;
    emit: EmitProbe;
    stream: StreamProbe[];
    yamux: YamuxProbe;
    ws_write: WsWriteSide[];
    copy: CopyDir[];
  };
}

// ── Scalar formatters ────────────────────────────────────────────────────────

// Nanoseconds → a tight human string. Picks the largest unit whose value is
// ≥1 so "350ns" stays ns and "1.2ms" doesn't pretend to be 1200µs. 0 is "0"
// (a real zero-latency observation, not missing data). Missing/empty reads as
// "—" so the eye separates "nothing happened" from "0ns happened".
export function fmtNs(ns: number): string {
  if (!Number.isFinite(ns)) return "—";
  if (ns === 0) return "0";
  if (ns < 0) return `-${fmtNs(-ns)}`;
  if (ns < 1000) return `${Math.round(ns)}ns`;
  if (ns < 1_000_000) return `${(ns / 1000).toFixed(1)}µs`;
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(2)}ms`;
  return `${(ns / 1_000_000_000).toFixed(2)}s`;
}

// Bytes → binary units (KiB/MiB/…). B stays as a raw integer count.
export function fmtBytes(b: number): string {
  if (!Number.isFinite(b) || b < 0) return "—";
  if (b < 1024) return `${b}B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = b;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v < 10 ? 2 : 1)}${units[i]}`;
}

// Counts → locale-grouped integers (e.g. 1,234,567). Falls back to "—" for
// non-finite input so the renderer doesn't have to guard.
export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US");
}

// A histogram with zero observations is the common "this path never ran" case
// — treat it as empty so callers can branch on it cheaply. The predicate spans
// undefined+null so the FALSE branch narrows to a real Histogram (excluding
// both absent and nullish inputs).
export function histEmpty(h: Histogram | undefined | null): h is undefined | null {
  return !h || h.count <= 0;
}

// One-line "p50 X · p95 Y · p99 Z" digest for a histogram. Empty → "—".
export function fmtPctiles(h: Histogram | undefined | null): string {
  if (histEmpty(h)) return "—";
  return `p50 ${fmtNs(h.p50_ns)} · p95 ${fmtNs(h.p95_ns)} · p99 ${fmtNs(h.p99_ns)}`;
}

// Histogram compact stats line: count + avg + the percentiles. For the dense
// on-screen rows where one line per probe keeps it scannable.
export function fmtHistLine(h: Histogram | undefined | null): string {
  if (histEmpty(h)) return "—";
  const avg = h.sum_ns > 0 ? fmtNs(h.sum_ns / h.count) : "0";
  return `n=${fmtNum(h.count)} avg=${avg} · p50 ${fmtNs(h.p50_ns)} p95 ${fmtNs(h.p95_ns)} p99 ${fmtNs(h.p99_ns)}`;
}

// "p50 X · p95 Y · p99 Z" digest for a histogram whose values are BYTES (not
// nanoseconds). The wire type reuses the *_ns field names for every histogram
// (see the Histogram interface), so a payload-size histogram (bytes_hist) ends
// up storing byte counts in p50_ns/p95_ns/p99_ns. Routing those through
// fmtPctiles would label them ns/µs/ms — e.g. "p50 10.0µs" for a 100-byte
// payload — which is meaningless. This formats the same three percentiles as
// byte sizes instead. Empty → "—".
export function fmtBytesPctiles(h: Histogram | undefined | null): string {
  if (histEmpty(h)) return "—";
  return `p50 ${fmtBytes(h.p50_ns)} · p95 ${fmtBytes(h.p95_ns)} · p99 ${fmtBytes(h.p99_ns)}`;
}

// Plain COUNT statistics for a histogram whose values are integer counts (not
// durations), e.g. active_streams_at_write. The latency bucket boundaries
// (smallest edge 1000, see latencyBucketsNs) collapse real stream counts
// (typically single digits) into the first bucket, so the percentile fields
// are MEANINGLESS for counts — rendering them would silently fabricate a
// "p50/p95/p99" that has no real meaning. Instead we surface the derivable
// count statistics: observation count (n), observed min/max, and the mean.
// avg is rounded to an integer (stream counts are whole numbers; a fractional
// mean adds noise). Empty → "—".
export function fmtCountStats(h: Histogram | undefined | null): string {
  if (histEmpty(h)) return "—";
  const avg = h.count > 0 ? Math.round(h.sum_ns / h.count) : 0;
  return `n=${fmtNum(h.count)} min=${fmtNum(h.min_ns)} max=${fmtNum(h.max_ns)} avg=${fmtNum(avg)}`;
}

// started_at_ns (a MonoNow ns offset captured at process start) isn't a wall
// clock — it's only useful as a relative "how long has collection been
// running" reference. We don't try to ISO-format it; we render the raw value
// so an operator comparing two snapshots can see elapsed = now - started.
export function fmtStarted(snap: DiagSnapshot): string {
  const v = snap?.started_at_ns;
  if (!Number.isFinite(v)) return "—";
  return fmtNum(v);
}

// ── "Copy summary" digest ────────────────────────────────────────────────────
//
// A compact, plain-text, one-screen digest of the snapshot for pasting into a
// bug report. Structured section-per-probe; every percentile line is
// "p50/p95/p99" so a reader gets the tail shape without scrolling JSON. The
// latency-attribution keys the operator cares about (yamux write-by-direction,
// ws_write mutex_wait vs write_msg, stream snapshot-vs-replay) are called out
// explicitly rather than buried in raw maps.

function mapLine(label: string, m: Record<string, number> | undefined): string {
  if (!m) return `${label}: (none)`;
  const entries = Object.entries(m).filter(([, v]) => v > 0);
  if (entries.length === 0) return `${label}: (all zero)`;
  return `${label}: ${entries.map(([k, v]) => `${k}=${fmtNum(v)}`).join(" ")}`;
}

function pctLine(label: string, h: Histogram | undefined | null): string {
  return `${label}: ${histEmpty(h) ? "(no samples)" : fmtPctiles(h)}`;
}

// Same shape as pctLine but formats the histogram as BYTES (for bytes_hist).
// bytes_hist reuses the *_ns histogram field names but holds payload byte
// counts — a duration formatter would mislabel them ns/µs/ms.
function byteLine(label: string, h: Histogram | undefined | null): string {
  return `${label}: ${histEmpty(h) ? "(no samples)" : fmtBytesPctiles(h)}`;
}

// Same shape as pctLine but formats the histogram as integer COUNT statistics
// (for active_streams_at_write). The latency bucket boundaries collapse real
// stream counts into the first bucket, so percentiles are meaningless here —
// surface min/max/avg/observations instead.
function countLine(label: string, h: Histogram | undefined | null): string {
  return `${label}: ${histEmpty(h) ? "(no samples)" : fmtCountStats(h)}`;
}

export function buildSummary(snap: DiagSnapshot): string {
  if (!snap || !snap.probes) return "(no diagnostics data)";
  const p = snap.probes;
  const lines: string[] = [];
  const push = (s: string) => lines.push(s);

  push("vh-solara latency diagnostics");
  push(`started_at_ns: ${fmtStarted(snap)}`);
  push("");

  // ingest
  push("ingest:");
  push(`  events ${fmtNum(p.ingest.events)} · bytes ${fmtBytes(p.ingest.bytes)}`);
  push(`  ${pctLine("dispatch_dur", p.ingest.dispatch_dur)}`);
  push(`  ${byteLine("bytes_hist", p.ingest.bytes_hist)}`);
  push("");

  // emit
  push("emit:");
  push(`  ${mapLine("class_count", p.emit.class_count)}`);
  push(`  ${mapLine("class_bytes", p.emit.class_bytes)}`);
  push(`  ${mapLine("source_count", p.emit.source_count)}`);
  push(`  ${pctLine("emit_age", p.emit.emit_age)}`);
  push(`  subscriber_drops ${fmtNum(p.emit.subscriber_drops)}`);
  push("");

  // stream[]
  for (const s of p.stream ?? []) {
    push(`stream (${s.class}):`);
    push(`  opens ${fmtNum(s.opens)} · bytes ${fmtBytes(s.bytes)} · writes ${fmtNum(s.writes)} · flushes ${fmtNum(s.flushes)} · write_errors ${fmtNum(s.write_errors)}`);
    push(`  ${pctLine("write_dur", s.write_dur)}`);
    push(`  ${pctLine("flush_dur", s.flush_dur)}`);
    push(`  snapshot_path ${fmtNum(s.snapshot_path)} (${fmtBytes(s.snapshot_bytes)}) · replay_path ${fmtNum(s.replay_path)}`);
    push(`  ${mapLine("disc_reason", s.disc_reason)}`);
    push(`  slow_writes ${(s.slow_writes ?? []).length} · slow_flushes ${(s.slow_flushes ?? []).length}`);
    push("");
  }

  // yamux
  push("yamux:");
  push(`  active_streams ${fmtNum(p.yamux.active_streams)} · streams_opened ${fmtNum(p.yamux.streams_opened)} · stream_open_fails ${fmtNum(p.yamux.stream_open_fails)}`);
  push(`  bytes_read ${fmtBytes(p.yamux.bytes_read)}`);
  push(`  ${pctLine("open_dur", p.yamux.open_dur)}`);
  for (const wd of p.yamux.write_by_dir ?? []) {
    push(`  write ${wd.dir}: bytes ${fmtBytes(wd.bytes)} · slow_writes ${fmtNum(wd.slow_writes)} · ${pctLine("dur", wd.dur)}`);
  }
  push(`  ${mapLine("close_reason", p.yamux.close_reason)}`);
  push("");

  // ws_write[]
  for (const w of p.ws_write ?? []) {
    push(`ws_write (${w.side}):`);
    push(`  bytes ${fmtBytes(w.bytes)} · writes ${fmtNum(w.writes)} · errors ${fmtNum(w.errors)}`);
    push(`  ${pctLine("mutex_wait_dur", w.mutex_wait_dur)}`);
    push(`  ${pctLine("write_msg_dur", w.write_msg_dur)}`);
    push(`  ${pctLine("total_dur", w.total_dur)}`);
    push(`  ${countLine("active_streams_at_write", w.active_streams_at_write)}`);
    push(`  slow_write_incidents ${(w.slow_write_incidents ?? []).length}`);
    push("");
  }

  // copy[]
  for (const c of p.copy ?? []) {
    push(`copy (${c.dir}):`);
    push(`  bytes ${fmtBytes(c.bytes)}`);
    push(`  ${pctLine("dur", c.dur)}`);
    push(`  ${mapLine("term", c.term)}`);
    push("");
  }

  return lines.join("\n").trimEnd();
}
