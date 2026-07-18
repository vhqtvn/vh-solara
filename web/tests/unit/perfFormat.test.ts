// Unit tests for perfFormat (pure functions; node env, no jsdom needed).
import { describe, expect, it } from "vitest";
import {
  buildAggregatedSummary,
  buildSummary,
  fmtBytes,
  fmtBytesPctiles,
  fmtCountStats,
  fmtHistLine,
  fmtNs,
  fmtNum,
  fmtPctiles,
  histEmpty,
  isAggregated,
  parseDiagView,
  type AggregatedDiag,
  type DiagSnapshot,
  type Histogram,
} from "../../src/lib/perfFormat";

function hist(opts: Partial<Histogram> = {}): Histogram {
  return {
    count: 0,
    sum_ns: 0,
    min_ns: 0,
    max_ns: 0,
    p50_ns: 0,
    p95_ns: 0,
    p99_ns: 0,
    avg_ns: 0,
    ...opts,
  };
}

describe("fmtNs", () => {
  it("renders 0 as '0' (real zero, not missing)", () => {
    expect(fmtNs(0)).toBe("0");
  });
  it("renders sub-µs in ns", () => {
    expect(fmtNs(350)).toBe("350ns");
    expect(fmtNs(999)).toBe("999ns");
  });
  it("renders sub-ms in µs with 1 decimal", () => {
    expect(fmtNs(1200)).toBe("1.2µs");
    expect(fmtNs(50_000)).toBe("50.0µs");
    expect(fmtNs(750_000)).toBe("750.0µs");
  });
  it("renders sub-second in ms with 2 decimals", () => {
    expect(fmtNs(1_500_000)).toBe("1.50ms");
    expect(fmtNs(10_000_000)).toBe("10.00ms");
  });
  it("renders >=1s in seconds", () => {
    expect(fmtNs(1_500_000_000)).toBe("1.50s");
  });
  it("non-finite → em-dash", () => {
    expect(fmtNs(NaN)).toBe("—");
    expect(fmtNs(Infinity)).toBe("—");
  });
});

describe("fmtBytes", () => {
  it("renders small byte counts as raw B", () => {
    expect(fmtBytes(0)).toBe("0B");
    expect(fmtBytes(512)).toBe("512B");
    expect(fmtBytes(1023)).toBe("1023B");
  });
  it("renders KiB at 1024", () => {
    expect(fmtBytes(1024)).toBe("1.00KiB");
    expect(fmtBytes(1536)).toBe("1.50KiB");
  });
  it("renders MiB", () => {
    expect(fmtBytes(1024 * 1024)).toBe("1.00MiB");
    expect(fmtBytes(1024 * 1024 * 5)).toBe("5.00MiB");
  });
});

describe("fmtNum", () => {
  it("groups thousands with en-US locale", () => {
    expect(fmtNum(1234567)).toBe("1,234,567");
    expect(fmtNum(0)).toBe("0");
  });
  it("non-finite → em-dash", () => {
    expect(fmtNum(NaN)).toBe("—");
  });
});

describe("histEmpty + fmtPctiles", () => {
  it("treats count=0 as empty", () => {
    expect(histEmpty(hist({ count: 0 }))).toBe(true);
    expect(histEmpty(hist({ count: 5 }))).toBe(false);
    expect(histEmpty(undefined)).toBe(true);
    expect(histEmpty(null)).toBe(true);
  });
  it("fmtPctiles empty → '—'", () => {
    expect(fmtPctiles(hist())).toBe("—");
    expect(fmtPctiles(undefined)).toBe("—");
  });
  it("fmtPctiles shows p50/p95/p99", () => {
    const h = hist({ count: 10, p50_ns: 1_000_000, p95_ns: 5_000_000, p99_ns: 10_000_000 });
    expect(fmtPctiles(h)).toBe("p50 1.00ms · p95 5.00ms · p99 10.00ms");
  });
});

describe("fmtHistLine", () => {
  it("shows count + avg + percentiles", () => {
    const h = hist({ count: 4, sum_ns: 4_000_000, p50_ns: 1_000_000, p95_ns: 1_500_000, p99_ns: 2_000_000 });
    expect(fmtHistLine(h)).toBe("n=4 avg=1.00ms · p50 1.00ms p95 1.50ms p99 2.00ms");
  });
  it("empty → '—'", () => {
    expect(fmtHistLine(hist())).toBe("—");
  });
});

describe("fmtBytesPctiles (F2: byte-size histograms, never duration units)", () => {
  it("renders byte-size percentiles via fmtBytes", () => {
    // p50=100 bytes, p95=150 bytes, p99=200 bytes — these are PAYLOAD sizes,
    // not nanoseconds. fmtBytesPctiles must label them B, never ns/µs/ms.
    const h = hist({ count: 42, p50_ns: 100, p95_ns: 150, p99_ns: 200 });
    expect(fmtBytesPctiles(h)).toBe("p50 100B · p95 150B · p99 200B");
  });
  it("renders KiB/MiB percentiles for larger payloads", () => {
    // fmtBytes uses 2 decimals below 10, 1 decimal at/above 10 (per the
    // documented `v < 10 ? 2 : 1` rule): 10240B → v=10.0 → "10.0KiB".
    const h = hist({ count: 10, p50_ns: 1024, p95_ns: 1024 * 10, p99_ns: 1024 * 1024 });
    expect(fmtBytesPctiles(h)).toBe("p50 1.00KiB · p95 10.0KiB · p99 1.00MiB");
  });
  it("NEVER emits duration units (ns/µs/ms) for byte values", () => {
    const h = hist({ count: 42, p50_ns: 100, p95_ns: 150, p99_ns: 200 });
    const out = fmtBytesPctiles(h);
    expect(out).not.toMatch(/\dns\b/);
    expect(out).not.toMatch(/µs/);
    expect(out).not.toMatch(/\bms\b/);
    expect(out).not.toMatch(/\bs\b/);
  });
  it("empty → '—'", () => {
    expect(fmtBytesPctiles(hist())).toBe("—");
    expect(fmtBytesPctiles(undefined)).toBe("—");
  });
});

describe("fmtCountStats (F2: count histograms, never duration units or fake percentiles)", () => {
  it("renders n/min/max/avg for stream-count observations", () => {
    // active_streams_at_write: 100 observations, min 1, max 8, sum 400 → avg 4.
    // These are stream COUNTS, not durations; the latency bucket edges collapse
    // real counts into the first bucket so percentiles are meaningless — we
    // surface n/min/max/avg instead.
    const h = hist({ count: 100, sum_ns: 400, min_ns: 1, max_ns: 8, p50_ns: 3, p95_ns: 6, p99_ns: 8, avg_ns: 4 });
    expect(fmtCountStats(h)).toBe("n=100 min=1 max=8 avg=4");
  });
  it("rounds the average to a whole count", () => {
    // sum 405 / count 100 = 4.05 → avg 4 (stream counts are whole numbers).
    const h = hist({ count: 100, sum_ns: 405, min_ns: 1, max_ns: 9 });
    expect(fmtCountStats(h)).toBe("n=100 min=1 max=9 avg=4");
  });
  it("NEVER emits duration units or p50/p95/p99 labels", () => {
    const h = hist({ count: 100, sum_ns: 400, min_ns: 1, max_ns: 8, p50_ns: 3, p95_ns: 6, p99_ns: 8 });
    const out = fmtCountStats(h);
    expect(out).not.toMatch(/\dns\b/);
    expect(out).not.toMatch(/µs/);
    expect(out).not.toMatch(/\bms\b/);
    expect(out).not.toMatch(/\bp50\b/);
    expect(out).not.toMatch(/\bp95\b/);
    expect(out).not.toMatch(/\bp99\b/);
  });
  it("empty → '—'", () => {
    expect(fmtCountStats(hist())).toBe("—");
    expect(fmtCountStats(null)).toBe("—");
  });
});

describe("buildSummary", () => {
  it("returns a placeholder for null/empty input", () => {
    expect(buildSummary(null as unknown as DiagSnapshot)).toBe("(no diagnostics data)");
    expect(buildSummary({} as DiagSnapshot)).toBe("(no diagnostics data)");
  });

  it("produces a digest with every section + the latency-attribution keys", () => {
    const snap: DiagSnapshot = {
      started_at_ns: 1_234_567_890,
      probes: {
        ingest: {
          events: 1000,
          bytes: 4096,
          dispatch_dur: hist({ count: 1000, sum_ns: 1_000_000_000, p50_ns: 1_000_000, p95_ns: 5_000_000, p99_ns: 10_000_000 }),
          bytes_hist: hist({ count: 1000, p50_ns: 512, p95_ns: 1024, p99_ns: 4096 }),
        },
        emit: {
          class_count: { structural: 100, message: 200, part: 500, messages_batch: 50, other: 0 },
          class_bytes: { structural: 1024, message: 2048 },
          source_count: { opencode_live: 800, hydrate: 10, daemon_generated: 5 },
          emit_age: hist({ count: 850, p50_ns: 2_000_000, p95_ns: 8_000_000, p99_ns: 15_000_000 }),
          subscriber_drops: 3,
        },
        stream: [
          {
            class: "tree",
            opens: 5, bytes: 8192, writes: 100, flushes: 50, write_errors: 1,
            write_dur: hist({ count: 100, p50_ns: 500_000, p95_ns: 2_000_000, p99_ns: 5_000_000 }),
            flush_dur: hist({ count: 50, p50_ns: 1_000_000, p95_ns: 3_000_000, p99_ns: 8_000_000 }),
            interarrival: hist(), ping_dur: hist(),
            snapshot_path: 2, replay_path: 3, snapshot_bytes: 4096,
            disc_reason: { request_ctx_closed: 4, subscriber_channel_closed: 0, write_failure: 1 },
            slow_writes: [{ at_ns: 1, kind: "slow", dur_ns: 60_000_000 }],
            slow_flushes: [],
          },
        ],
        yamux: {
          streams_opened: 10, stream_open_fails: 1, active_streams: 3,
          open_dur: hist({ count: 10, p50_ns: 5_000_000, p95_ns: 20_000_000, p99_ns: 50_000_000 }),
          bytes_read: 1_048_576,
          write_by_dir: [
            { dir: "yamux_response", bytes: 2_097_152, dur: hist({ count: 200, p50_ns: 800_000, p95_ns: 4_000_000, p99_ns: 12_000_000 }), slow_writes: 2, slow_write_incidents: [] },
            { dir: "yamux_request", bytes: 1024, dur: hist({ count: 50, p50_ns: 100_000, p95_ns: 500_000, p99_ns: 1_000_000 }), slow_writes: 0, slow_write_incidents: [] },
          ],
          close_reason: { ack: 7, setup: 2, copy_error: 1 },
        },
        ws_write: [
          {
            side: "controller_server", bytes: 4_194_304, writes: 500, errors: 2,
            mutex_wait_dur: hist({ count: 500, p50_ns: 50_000, p95_ns: 200_000, p99_ns: 800_000 }),
            write_msg_dur: hist({ count: 500, p50_ns: 300_000, p95_ns: 1_500_000, p99_ns: 5_000_000 }),
            total_dur: hist({ count: 500, p50_ns: 350_000, p95_ns: 1_700_000, p99_ns: 5_800_000 }),
            active_streams_at_write: hist({ count: 500, sum_ns: 1500, min_ns: 1, max_ns: 8, p50_ns: 3, p95_ns: 5, p99_ns: 8 }),
            slow_write_incidents: [{ at_ns: 1, kind: "slow", dur_ns: 110_000_000 }],
          },
          {
            side: "worker_client", bytes: 1_048_576, writes: 200, errors: 0,
            mutex_wait_dur: hist(), write_msg_dur: hist(), total_dur: hist(), active_streams_at_write: hist(),
            slow_write_incidents: [],
          },
        ],
        copy: [
          { dir: "yamux_to_browser", bytes: 8_388_608, dur: hist({ count: 8, p50_ns: 10_000_000, p95_ns: 30_000_000, p99_ns: 80_000_000 }), term: { normal: 7, error: 1 } },
          { dir: "browser_to_yamux", bytes: 1024, dur: hist(), term: { normal: 1, error: 0 } },
        ],
      },
    };
    const out = buildSummary(snap);

    // Every section present.
    expect(out).toContain("vh-solara latency diagnostics");
    expect(out).toContain("started_at_ns: 1,234,567,890");
    expect(out).toContain("ingest:");
    expect(out).toContain("emit:");
    expect(out).toContain("stream (tree):");
    expect(out).toContain("yamux:");
    expect(out).toContain("ws_write (controller_server):");
    expect(out).toContain("ws_write (worker_client):");
    expect(out).toContain("copy (yamux_to_browser):");
    expect(out).toContain("copy (browser_to_yamux):");

    // Latency-attribution keys the operator specifically wants.
    expect(out).toContain("write yamux_response: bytes 2.00MiB · slow_writes 2");
    expect(out).toContain("write yamux_request:");
    expect(out).toContain("mutex_wait_dur: p50 50.0µs · p95 200.0µs · p99 800.0µs");
    expect(out).toContain("write_msg_dur: p50 300.0µs · p95 1.50ms · p99 5.00ms");
    expect(out).toContain("snapshot_path 2 (4.00KiB) · replay_path 3");
    expect(out).toContain("subscriber_drops 3");

    // Empty ws_write side (worker_client) renders "(no samples)" not bogus numbers.
    expect(out).toContain("mutex_wait_dur: (no samples)");

    // F2: bytes_hist renders as byte units (KiB/B), NEVER duration units.
    expect(out).toContain("bytes_hist: p50 512B · p95 1.00KiB · p99 4.00KiB");
    expect(out).not.toMatch(/bytes_hist:[^\n]*\b(ns|µs|ms|s)\b/);

    // F2: active_streams_at_write renders as count stats (n/min/max/avg),
    // NEVER duration units or fabricated percentiles. controller_server has
    // count=500 sum=1500 min=1 max=8 → avg=3.
    expect(out).toContain("active_streams_at_write: n=500 min=1 max=8 avg=3");
    expect(out).not.toMatch(/active_streams_at_write:[^\n]*(ns|µs|ms|p50|p95|p99)/);
  });
});

// ── Aggregated wire-shape helpers (isAggregated + parseDiagView + buildAggregatedSummary) ──

describe("isAggregated + parseDiagView (topology detection)", () => {
  it("recognizes the aggregated envelope by the `workers` key", () => {
    expect(isAggregated({ controller: null, workers: {}, failures: {} })).toBe(true);
    expect(isAggregated({ controller: { started_at_ns: 1, probes: {} }, workers: { w1: {} }, failures: {} })).toBe(true);
    // Empty `workers` map still counts as aggregated (the topology marker is
    // the field's presence, not its contents — a controller with no workers
    // still serves the aggregated shape).
    expect(isAggregated({ controller: null, workers: {}, failures: {}, worker_info: {} })).toBe(true);
  });

  it("rejects the single-shape (direct topology) and garbage inputs", () => {
    expect(isAggregated({ started_at_ns: 1, probes: {} })).toBe(false);
    expect(isAggregated(null)).toBe(false);
    expect(isAggregated(undefined)).toBe(false);
    expect(isAggregated("not an object")).toBe(false);
    expect(isAggregated({})).toBe(false);
  });

  it("parseDiagView routes the aggregated envelope to kind=aggregated", () => {
    const env = {
      controller: { started_at_ns: 1, probes: {} },
      workers: { w1: { started_at_ns: 2, probes: {} } },
      failures: { w2: "transport closed" },
      worker_info: { w1: { name: "node-1", status: "online", version: "v1.0.0" } },
    };
    const v = parseDiagView(JSON.stringify(env));
    expect(v.kind).toBe("aggregated");
    if (v.kind === "aggregated") {
      expect(v.agg.workers.w1.started_at_ns).toBe(2);
      expect(v.agg.failures.w2).toBe("transport closed");
      expect(v.agg.worker_info?.w1.name).toBe("node-1");
    }
  });

  it("parseDiagView routes the single-shape (direct topology) to kind=single", () => {
    const v = parseDiagView(JSON.stringify({ started_at_ns: 99, probes: {} }));
    expect(v.kind).toBe("single");
    if (v.kind === "single") {
      expect(v.snap.started_at_ns).toBe(99);
    }
  });

  it("parseDiagView throws on invalid JSON", () => {
    expect(() => parseDiagView("not json")).toThrow();
  });

  it("parseDiagView throws on an unrecognized shape (neither aggregated nor single)", () => {
    // An object without `workers` AND without `probes` — neither topology.
    expect(() => parseDiagView(JSON.stringify({ foo: "bar" }))).toThrow();
  });
});

describe("buildAggregatedSummary", () => {
  function miniSnap(startedAt: number, events: number): DiagSnapshot {
    return {
      started_at_ns: startedAt,
      probes: {
        ingest: {
          events,
          bytes: 4096,
          dispatch_dur: hist({ count: events }),
          bytes_hist: hist({ count: events }),
        },
        emit: {
          class_count: {}, class_bytes: {}, source_count: {},
          emit_age: hist(), subscriber_drops: 0,
        },
        stream: [],
        yamux: {
          streams_opened: 0, stream_open_fails: 0, active_streams: 0,
          open_dur: hist(), bytes_read: 0, write_by_dir: [], close_reason: {},
        },
        ws_write: [],
        copy: [],
      },
    };
  }

  it("returns a placeholder for null input", () => {
    expect(buildAggregatedSummary(null as unknown as AggregatedDiag)).toBe("(no diagnostics data)");
  });

  it("emits the aggregated header with worker/failure counts", () => {
    const agg: AggregatedDiag = {
      controller: miniSnap(100, 10),
      workers: { w1: miniSnap(200, 20), w2: miniSnap(300, 30) },
      failures: { w3: "context deadline exceeded" },
    };
    const out = buildAggregatedSummary(agg);
    expect(out).toContain("vh-solara latency diagnostics (aggregated)");
    expect(out).toContain("workers: 2 ok · 1 failed");
    expect(out).toContain("FAILED w3: context deadline exceeded");
  });

  it("renders a section per entity (controller + each worker) with full bodies", () => {
    const agg: AggregatedDiag = {
      controller: miniSnap(100, 10),
      workers: { w1: miniSnap(200, 20), w2: miniSnap(300, 30) },
      failures: {},
      worker_info: {
        w1: { name: "node-east", status: "online", version: "v1.0.0" },
        w2: { name: "node-west", status: "online" },
      },
    };
    const out = buildAggregatedSummary(agg);

    // Controller section.
    expect(out).toContain("=== controller ===");
    expect(out).toContain("started_at_ns: 100");

    // Worker sections — sorted by ID (w1 before w2). Each section carries the
    // human name + the stable ID so an operator can attribute latency.
    const w1Idx = out.indexOf("=== worker === · node-east (w1)");
    const w2Idx = out.indexOf("=== worker === · node-west (w2)");
    expect(w1Idx).toBeGreaterThan(-1);
    expect(w2Idx).toBeGreaterThan(-1);
    expect(w1Idx).toBeLessThan(w2Idx); // stable sort by worker ID
    expect(out).toContain("started_at_ns: 200");
    expect(out).toContain("started_at_ns: 300");
  });

  it("falls back to bare IDs when worker_info is missing", () => {
    const agg: AggregatedDiag = {
      controller: miniSnap(100, 10),
      workers: { lonely: miniSnap(200, 20) },
      failures: {},
    };
    const out = buildAggregatedSummary(agg);
    expect(out).toContain("=== worker === (lonely)");
  });

  it("handles a null controller (rare but defended) without crashing", () => {
    const agg: AggregatedDiag = {
      controller: null,
      workers: { w1: miniSnap(200, 20) },
      failures: {},
    };
    const out = buildAggregatedSummary(agg);
    expect(out).toContain("=== controller ===");
    expect(out).toContain("(controller snapshot unavailable)");
    expect(out).toContain("=== worker === (w1)");
  });

  it("handles an empty fleet (controller only, no workers, no failures)", () => {
    const agg: AggregatedDiag = {
      controller: miniSnap(100, 10),
      workers: {},
      failures: {},
    };
    const out = buildAggregatedSummary(agg);
    expect(out).toContain("workers: 0 ok · 0 failed");
    expect(out).toContain("=== controller ===");
  });
});
