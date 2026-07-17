// @vitest-environment jsdom
//
// Coverage for the opt-in Performance diagnostics viewer:
//   • fetches GET /vh/diag/latency on open and renders the sectioned body
//     (ingest / emit / stream / yamux / ws_write / copy) with the latency-
//     attribution rows the operator cares about (yamux write-by-direction,
//     ws_write mutex_wait vs write_msg).
//   • Copy JSON copies the verbatim response; Copy summary copies a compact
//     digest. Both use navigator.clipboard.writeText and show a "Copied"
//     confirmation.
//   • an HTTP error shows the error row with a Retry affordance.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

import PerformanceDialog from "../../src/components/PerformanceDialog";

const SNAP = {
  started_at_ns: 1_000_000,
  probes: {
    ingest: {
      events: 42,
      bytes: 4096,
      dispatch_dur: { count: 42, sum_ns: 42_000_000, min_ns: 100_000, max_ns: 5_000_000, p50_ns: 1_000_000, p95_ns: 3_000_000, p99_ns: 5_000_000, avg_ns: 1_000_000 },
      bytes_hist: { count: 42, sum_ns: 4096, min_ns: 10, max_ns: 200, p50_ns: 100, p95_ns: 150, p99_ns: 200, avg_ns: 97 },
    },
    emit: {
      class_count: { structural: 10, message: 5, part: 20, messages_batch: 2, other: 0 },
      class_bytes: { structural: 1024 },
      source_count: { opencode_live: 30, hydrate: 5, daemon_generated: 2 },
      emit_age: { count: 37, sum_ns: 74_000_000, min_ns: 50_000, max_ns: 10_000_000, p50_ns: 2_000_000, p95_ns: 8_000_000, p99_ns: 10_000_000, avg_ns: 2_000_000 },
      subscriber_drops: 1,
    },
    stream: [
      {
        class: "tree",
        opens: 3, bytes: 8192, writes: 12, flushes: 6, write_errors: 0,
        write_dur: { count: 12, sum_ns: 6_000_000, min_ns: 100_000, max_ns: 2_000_000, p50_ns: 500_000, p95_ns: 1_500_000, p99_ns: 2_000_000, avg_ns: 500_000 },
        flush_dur: { count: 6, sum_ns: 6_000_000, min_ns: 500_000, max_ns: 3_000_000, p50_ns: 1_000_000, p95_ns: 2_500_000, p99_ns: 3_000_000, avg_ns: 1_000_000 },
        interarrival: { count: 0, sum_ns: 0, min_ns: 0, max_ns: 0, p50_ns: 0, p95_ns: 0, p99_ns: 0, avg_ns: 0 },
        ping_dur: { count: 0, sum_ns: 0, min_ns: 0, max_ns: 0, p50_ns: 0, p95_ns: 0, p99_ns: 0, avg_ns: 0 },
        snapshot_path: 2, replay_path: 1, snapshot_bytes: 4096,
        disc_reason: { request_ctx_closed: 2, subscriber_channel_closed: 0, write_failure: 0 },
        slow_writes: [], slow_flushes: [],
      },
    ],
    yamux: {
      streams_opened: 5, stream_open_fails: 0, active_streams: 2,
      open_dur: { count: 5, sum_ns: 25_000_000, min_ns: 1_000_000, max_ns: 10_000_000, p50_ns: 5_000_000, p95_ns: 9_000_000, p99_ns: 10_000_000, avg_ns: 5_000_000 },
      bytes_read: 1_048_576,
      write_by_dir: [
        { dir: "yamux_response", bytes: 2_097_152, dur: { count: 50, sum_ns: 40_000_000, min_ns: 200_000, max_ns: 4_000_000, p50_ns: 800_000, p95_ns: 2_000_000, p99_ns: 4_000_000, avg_ns: 800_000 }, slow_writes: 1, slow_write_incidents: [] },
        { dir: "yamux_request", bytes: 512, dur: { count: 10, sum_ns: 1_000_000, min_ns: 50_000, max_ns: 200_000, p50_ns: 100_000, p95_ns: 150_000, p99_ns: 200_000, avg_ns: 100_000 }, slow_writes: 0, slow_write_incidents: [] },
      ],
      close_reason: { ack: 3, setup: 1, copy_error: 0 },
    },
    ws_write: [
      {
        side: "controller_server", bytes: 4_194_304, writes: 100, errors: 1,
        mutex_wait_dur: { count: 100, sum_ns: 5_000_000, min_ns: 10_000, max_ns: 500_000, p50_ns: 50_000, p95_ns: 200_000, p99_ns: 500_000, avg_ns: 50_000 },
        write_msg_dur: { count: 100, sum_ns: 30_000_000, min_ns: 100_000, max_ns: 3_000_000, p50_ns: 300_000, p95_ns: 1_500_000, p99_ns: 3_000_000, avg_ns: 300_000 },
        total_dur: { count: 100, sum_ns: 35_000_000, min_ns: 110_000, max_ns: 3_500_000, p50_ns: 350_000, p95_ns: 1_700_000, p99_ns: 3_500_000, avg_ns: 350_000 },
        active_streams_at_write: { count: 100, sum_ns: 400, min_ns: 1, max_ns: 8, p50_ns: 3, p95_ns: 6, p99_ns: 8, avg_ns: 4 },
        slow_write_incidents: [],
      },
    ],
    copy: [
      { dir: "yamux_to_browser", bytes: 8_388_608, dur: { count: 4, sum_ns: 40_000_000, min_ns: 5_000_000, max_ns: 15_000_000, p50_ns: 10_000_000, p95_ns: 14_000_000, p99_ns: 15_000_000, avg_ns: 10_000_000 }, term: { normal: 4, error: 0 } },
    ],
  },
};

function respJson(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe("PerformanceDialog", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    // Drop the clipboard shim so the next test starts clean.
    delete (navigator as any).clipboard;
    localStorage.clear();
  });

  // jsdom doesn't provide navigator.clipboard by default; shim it on the
  // navigator object (the component reads navigator.clipboard.writeText).
  function shimClipboard(writeText: ReturnType<typeof vi.fn>) {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
  }

  it("fetches /vh/diag/latency on open and renders the sectioned body", async () => {
    const fetchMock = vi.fn((url: string) =>
      url.includes("/vh/diag/latency")
        ? Promise.resolve(respJson(SNAP))
        : Promise.resolve(respJson({}, false, 404)),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(() => <PerformanceDialog onClose={() => {}} />);

    // Fetch called once with the CSRF header.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toContain("/vh/diag/latency");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-VH-CSRF"]).toBe("1");

    // Section headers present.
    await waitFor(() => {
      expect(document.body.textContent).toContain("Ingest");
      expect(document.body.textContent).toContain("Emit");
      expect(document.body.textContent).toContain("Stream · tree");
      expect(document.body.textContent).toContain("Yamux");
      expect(document.body.textContent).toContain("WebSocket write · controller_server");
      expect(document.body.textContent).toContain("Copy · yamux_to_browser");
    });

    // Latency-attribution keys render with human formatting.
    expect(document.body.textContent).toContain("yamux_response");
    expect(document.body.textContent).toContain("yamux_request");
    expect(document.body.textContent).toContain("mutex wait");
    expect(document.body.textContent).toContain("write message");
    // A p50 of 1ms from dispatch_dur shows up as "1.00ms".
    expect(document.body.textContent).toContain("1.00ms");
  });

  it("Copy JSON copies the verbatim response and flashes confirmation", async () => {
    const writeText = vi.fn(async () => undefined);
    shimClipboard(writeText);
    const fetchMock = vi.fn(() => Promise.resolve(respJson(SNAP)));
    vi.stubGlobal("fetch", fetchMock);

    render(() => <PerformanceDialog onClose={() => {}} />);

    // Wait for the body + copy buttons.
    await waitFor(() => {
      expect(document.body.textContent).toContain("Ingest");
    });
    const copyJsonBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent || "").includes("Copy JSON"),
    );
    expect(copyJsonBtn).toBeTruthy();
    copyJsonBtn!.click();

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    // Verbatim JSON of the response — EXACT equality with the full response
    // string (strengthened from a loose toContain so a future regression that
    // corrupts raw() with a summary is caught).
    const expected = JSON.stringify(SNAP);
    const copied = writeText.mock.calls[0][0];
    expect(copied).toBe(expected);
    // Confirmation flash.
    await waitFor(() => {
      expect(document.body.textContent).toContain("Copied json");
    });
  });

  it("Copy summary copies a compact digest", async () => {
    const writeText = vi.fn(async () => undefined);
    shimClipboard(writeText);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(respJson(SNAP))));

    render(() => <PerformanceDialog onClose={() => {}} />);

    await waitFor(() => expect(document.body.textContent).toContain("Ingest"));
    const copySummaryBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent || "").includes("Copy summary"),
    );
    expect(copySummaryBtn).toBeTruthy();
    copySummaryBtn!.click();

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = writeText.mock.calls[0][0] as string;
    // The digest is human-readable text (not JSON) and names the probes.
    expect(copied).toContain("vh-solara latency diagnostics");
    expect(copied).toContain("ingest:");
    expect(copied).toContain("emit_age");
    expect(copied).toContain("mutex_wait_dur");
    await waitFor(() => {
      expect(document.body.textContent).toContain("Copied summary");
    });
  });

  it("shows an error row with Retry on a failed fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(respJson({ error: "nope" }, false, 500))),
    );

    render(() => <PerformanceDialog onClose={() => {}} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Couldn't load diagnostics");
      expect(document.body.textContent).toContain("HTTP 500");
    });
    // A retry button is present.
    const retry = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent || "").includes("Retry"),
    );
    expect(retry).toBeTruthy();
  });

  it("Escape closes the dialog", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(respJson(SNAP))));
    const onClose = vi.fn();
    render(() => <PerformanceDialog onClose={onClose} />);

    await waitFor(() => expect(document.body.textContent).toContain("Performance"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalled();
  });

  // ── F2: byte/count histograms render through the correct formatter ────────

  it("renders bytes_hist with byte units (never ns/µs/ms) [F2]", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(respJson(SNAP))));
    render(() => <PerformanceDialog onClose={() => {}} />);

    // Wait for the Ingest section + the bytes histogram row.
    await waitFor(() => {
      expect(document.body.textContent).toContain("bytes histogram");
    });
    // SNAP.ingest.bytes_hist: p50=100, p95=150, p99=200 → byte units (B).
    expect(document.body.textContent).toContain("p50 100B · p95 150B · p99 200B");
    // The bytes-histogram row must not leak duration units for these byte values.
    const row = Array.from(document.querySelectorAll("span"))
      .find((s) => (s.textContent || "").includes("bytes histogram"));
    const value = row?.nextElementSibling?.textContent || "";
    expect(value).not.toMatch(/\dns\b/);
    expect(value).not.toMatch(/µs/);
    expect(value).not.toMatch(/\bms\b/);
  });

  it("renders active_streams_at_write as count stats (never duration units) [F2]", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(respJson(SNAP))));
    render(() => <PerformanceDialog onClose={() => {}} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("active streams at write");
    });
    // SNAP.ws_write[0].active_streams_at_write: count=100 sum=400 min=1 max=8 → avg=4.
    expect(document.body.textContent).toContain("n=100 min=1 max=8 avg=4");
    // The row must not leak duration units or fabricated percentiles.
    const row = Array.from(document.querySelectorAll("span"))
      .find((s) => (s.textContent || "").includes("active streams at write"));
    const value = row?.nextElementSibling?.textContent || "";
    expect(value).not.toMatch(/\dns\b/);
    expect(value).not.toMatch(/µs/);
    expect(value).not.toMatch(/\bms\b/);
    expect(value).not.toMatch(/\bp(50|95|99)\b/);
  });

  // ── F1: raw() is immutable; summary fallback never corrupts a later JSON copy ──

  it("Copy summary fallback leaves raw() intact so a later Copy JSON copies the original response [F1]", async () => {
    // First copy (summary) fails → fallback path stages the summary into the
    // off-screen textarea. Then the clipboard starts succeeding and Copy JSON
    // is clicked: it MUST receive the ORIGINAL raw response, not the summary.
    const writeText = vi.fn(async () => undefined);
    // Start with a clipboard that REJECTS so the summary copy takes the fallback.
    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    shimClipboard(writeText);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(respJson(SNAP))));

    render(() => <PerformanceDialog onClose={() => {}} />);
    await waitFor(() => expect(document.body.textContent).toContain("Ingest"));

    // (1) Copy summary with a failing clipboard → fallback stages the summary.
    const copySummaryBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent || "").includes("Copy summary"),
    );
    copySummaryBtn!.click();
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    // The off-screen textarea must now hold the summary text (the fallback
    // surfaced it so a manual copy would work), AND raw() must be unchanged.
    const ta = document.querySelector("textarea") as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    expect(ta.value).toContain("vh-solara latency diagnostics");

    // (2) Now clipboard succeeds. Copy JSON must receive the EXACT original
    // raw response — proving the summary fallback never overwrote raw().
    const copyJsonBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent || "").includes("Copy JSON"),
    );
    copyJsonBtn!.click();
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    const jsonCopied = writeText.mock.calls[1][0];
    expect(jsonCopied).toBe(JSON.stringify(SNAP));
    // And it is NOT the summary.
    expect(jsonCopied).not.toContain("vh-solara latency diagnostics");
    expect(jsonCopied).toContain("started_at_ns");
  });

  it("Copy JSON fallback stages the raw response (not a summary) into the textarea [F1 + clipboard fallback]", async () => {
    // Clipboard unavailable entirely (undefined) — both copies fall back.
    const writeText = vi.fn(async () => {
      throw new Error("no clipboard");
    });
    shimClipboard(writeText);
    const focusSpy = vi.fn();
    const selectSpy = vi.fn();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(respJson(SNAP))));

    render(() => <PerformanceDialog onClose={() => {}} />);
    await waitFor(() => expect(document.body.textContent).toContain("Ingest"));

    const ta = document.querySelector("textarea") as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    ta.focus = focusSpy;
    ta.select = selectSpy;

    const copyJsonBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent || "").includes("Copy JSON"),
    );
    copyJsonBtn!.click();
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    // The fallback staged the RAW response into the textarea and attempted
    // focus+select (so a manual Cmd-C works on a clipboard-less browser).
    await waitFor(() => expect(focusSpy).toHaveBeenCalled());
    expect(selectSpy).toHaveBeenCalled();
    expect(ta.value).toBe(JSON.stringify(SNAP));
    expect(ta.value).toContain("started_at_ns");
    // raw() stays the verbatim response — no summary leaked in.
    expect(ta.value).not.toContain("vh-solara latency diagnostics");
  });

  // ── Non-blocking: auto-refresh in-flight guard ─────────────────────────────

  it("does not fetch again when auto-refresh is off", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(respJson(SNAP)));
    vi.stubGlobal("fetch", fetchMock);

    render(() => <PerformanceDialog onClose={() => {}} />);
    await waitFor(() => expect(document.body.textContent).toContain("Ingest"));
    const initial = fetchMock.mock.calls.length;
    // With auto-refresh off, advancing timers / waiting must not add fetches.
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock.mock.calls.length).toBe(initial);
  });

  it("auto-refresh polls on cadence but skips a tick while a request is in flight", async () => {
    vi.useFakeTimers();
    try {
      // A slow endpoint: the first fetch hangs so the next auto-refresh tick
      // (2s later) must SKIP it (loading() is still true) — no overlapping
      // request. When the first resolves, subsequent ticks may resume.
      let resolveFirst!: (r: Response) => void;
      const firstPending = new Promise<Response>((res) => {
        resolveFirst = res;
      });
      const fetchMock = vi.fn();
      fetchMock.mockImplementationOnce(() => firstPending);
      fetchMock.mockImplementation(() => Promise.resolve(respJson(SNAP)));
      vi.stubGlobal("fetch", fetchMock);

      render(() => <PerformanceDialog onClose={() => {}} />);
      // Initial onMount fetch is the hanging one.
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Turn auto-refresh on.
      const toggle = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(toggle).toBeTruthy();
      toggle.checked = true;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));

      // Advance one full cadence (2s) while the first request is STILL pending.
      await vi.advanceTimersByTimeAsync(2000);
      // The tick must have been skipped: no second fetch while loading.
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Now resolve the first request; advance another cadence and confirm a
      // fresh fetch happens (the in-flight guard cleared).
      resolveFirst(respJson(SNAP));
      await vi.advanceTimersByTimeAsync(2000);
      await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling after unmount/close", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(() => Promise.resolve(respJson(SNAP)));
      vi.stubGlobal("fetch", fetchMock);
      const { unmount } = render(() => <PerformanceDialog onClose={() => {}} />);
      await vi.advanceTimersByTimeAsync(0);

      const toggle = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));

      await vi.advanceTimersByTimeAsync(2000);
      const before = fetchMock.mock.calls.length;
      expect(before).toBeGreaterThanOrEqual(2);

      // Unmount tears down the interval.
      unmount();
      await vi.advanceTimersByTimeAsync(6000);
      expect(fetchMock.mock.calls.length).toBe(before); // no further fetches
    } finally {
      vi.useRealTimers();
    }
  });
});
