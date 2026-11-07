// @vitest-environment jsdom
//
// D7 residue — the __vhSyncDiag snapshot folded into DiagLogDialog.
//
// The snapshot getter (window.__vhSyncDiag, installed once by startSync)
// was console-only. DiagLogDialog now surfaces it as a collapsed section
// and includes its JSON in Copy-all. Pins:
//   - getter installed → the dialog renders a sync-snapshot <pre> carrying
//     the JSON of what the getter returns;
//   - Copy-all is offered with ZERO entries whenever a snapshot exists,
//     and its clipboard payload bundles the snapshot JSON under the
//     `--- __vhSyncDiag ---` separator;
//   - getter ABSENT (early boot / test envs) → the dialog still renders,
//     shows the absence note, and does NOT offer Copy-all (nothing to
//     copy beyond the "(no entries)" placeholder).
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DiagLogDialog from "../../src/components/DiagLogDialog";
import {
  _resetDiagForTest,
  captureDiagEntry,
  entryLine,
  setDiagLogOn,
  type ColdOpenEntry,
} from "../../src/sync/diaglog";

const SNAPSHOT = {
  recovery: { "re-snapshot": 2 },
  streamOpens: { tree: { hybrid: 3 } },
  snapshotBytes: { tree: 1234, session: 567 },
  weakLink: { state: "ok" },
  generatedAt: 1790000000000,
};

type SyncDiagWindow = { __vhSyncDiag?: () => unknown };

// A cold-open entry shape as the real capture path records it (same field
// posture as diaglog.test.ts's `e()` helper). Fixed small ts values keep
// entryLine's rendering deterministic; the age cap never fires because caps
// are evaluated against the entry's OWN ts at capture.
const coldOpen = (ts: number, sessionId: string): ColdOpenEntry => ({
  kind: "cold-open",
  ts,
  sessionId,
  open: 10,
  snap: 20,
  hydrate: 30,
  fetchMs: 40,
  reconcileMs: 50,
});

beforeEach(() => {
  // jsdom 30 made window.navigator getter-only — clone-and-override via
  // defineProperty instead of plain assignment (same as AmbiguousChip).
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { ...(globalThis as unknown as Navigator) },
  });
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => {}) },
  });
  // Seeded-entries tests (Copy-all with entries) use the REAL capture path,
  // which persists to localStorage — start every test from the default-off,
  // empty-buffer state (same posture as diaglog.test.ts) so a seeded test
  // cannot leak entries/toggle into the zero-entry postures.
  localStorage.clear();
  _resetDiagForTest();
});

afterEach(() => {
  cleanup();
  delete (window as SyncDiagWindow).__vhSyncDiag;
});

describe("DiagLogDialog __vhSyncDiag fold-in", () => {
  it("renders the snapshot JSON in the sync-snapshot section when the getter is installed", () => {
    (window as SyncDiagWindow).__vhSyncDiag = () => SNAPSHOT;
    render(() => <DiagLogDialog onClose={() => {}} />);
    const pre = screen.getByLabelText("Sync snapshot");
    expect(pre.textContent).toContain('"re-snapshot": 2');
    expect(pre.textContent).toContain(JSON.stringify(SNAPSHOT.generatedAt));
  });

  it("Copy-all is offered with zero entries and its clipboard payload includes the snapshot JSON", () => {
    (window as SyncDiagWindow).__vhSyncDiag = () => SNAPSHOT;
    render(() => <DiagLogDialog onClose={() => {}} />);
    const btn = screen.getByRole("button", { name: /copy all/i });
    fireEvent.click(btn);
    const writeText = vi.mocked(navigator.clipboard.writeText);
    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = writeText.mock.calls[0][0] as string;
    expect(payload).toContain("--- __vhSyncDiag ---");
    expect(payload).toContain('"streamOpens"');
  });

  it("Copy-all with entries present concat is exactly entries (newest first) + blank line + separator + snapshot JSON", () => {
    // Seed through the REAL capture path: enable the toggle, then capture
    // two cold-open entries oldest-first (the ring stores newest last; the
    // dialog's list reverses to newest-first for display AND Copy-all).
    setDiagLogOn(true);
    const older = coldOpen(1000, "s1");
    const newer = coldOpen(2000, "s2");
    captureDiagEntry(older);
    captureDiagEntry(newer);

    // The snapshot is read ONCE at dialog open — install the getter BEFORE
    // render (same ordering as the zero-entries test above).
    (window as SyncDiagWindow).__vhSyncDiag = () => SNAPSHOT;
    render(() => <DiagLogDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /copy all/i }));
    const writeText = vi.mocked(navigator.clipboard.writeText);
    expect(writeText).toHaveBeenCalledTimes(1);
    // The exact combined arm of DiagLogDialog's allText() when BOTH entries
    // and a snapshot exist: entry lines (newest first, "\n"-joined), then a
    // blank line, the separator, and the pretty-printed snapshot JSON.
    expect(writeText.mock.calls[0][0] as string).toBe(
      `${entryLine(newer)}\n${entryLine(older)}\n\n--- __vhSyncDiag ---\n${JSON.stringify(SNAPSHOT, null, 2)}`,
    );
  });

  it("renders an absence note and no Copy-all when the getter is not installed", () => {
    render(() => <DiagLogDialog onClose={() => {}} />);
    expect(screen.getByText(/Not installed in this session/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /copy all/i })).toBeNull();
  });

  it("renders an absence note and no Copy-all when the getter throws (review B2/C1/D1)", () => {
    (window as SyncDiagWindow).__vhSyncDiag = () => {
      throw new Error("boom");
    };
    render(() => <DiagLogDialog onClose={() => {}} />);
    expect(screen.getByText(/Not installed in this session/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /copy all/i })).toBeNull();
  });
});

// Copy-all status feedback (debate-settled shape: scoped inline text — the
// dialog is the recurrence-capture instrument, a failed export must not
// look identical to a successful one). Pins:
//   - resolved write → the success line;
//   - rejected write → the failure line with the exact manual-guidance
//     wording;
//   - absent clipboard API (navigator.clipboard undefined) → failure line;
//   - retry recovery: a new attempt clears prior status and the LATEST
//     attempt's result wins (an earlier attempt settling late cannot
//     clobber — attempt-token guard);
//   - reopen/reset: a fresh mount carries no stale status, and a prior
//     instance's late-settling attempt cannot repopulate it.
const FAIL_MSG =
  "Copy failed — select and copy the text manually. Expand sync diagnostics to include that snapshot.";

// The status line is a role="status" element below the list header row.
const statusText = (): string | null => {
  const el = screen.queryByRole("status");
  return el ? (el.textContent ?? null) : null;
};

// Flush microtask turns so a late-settling attempt's continuation has run
// before asserting it did NOT change anything (negative assertions have no
// auto-wait).
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe("DiagLogDialog Copy-all status feedback", () => {
  it("resolved write shows the success line", async () => {
    (window as SyncDiagWindow).__vhSyncDiag = () => SNAPSHOT;
    render(() => <DiagLogDialog onClose={() => {}} />);
    expect(statusText()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /copy all/i }));
    await vi.waitFor(() => expect(statusText()).toBe("Snapshot copied."));
  });

  it("rejected write shows the failure line with the manual-guidance wording", async () => {
    (window as SyncDiagWindow).__vhSyncDiag = () => SNAPSHOT;
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new DOMException("write denied", "NotAllowedError");
        }),
      },
    });
    render(() => <DiagLogDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /copy all/i }));
    await vi.waitFor(() => expect(statusText()).toBe(FAIL_MSG));
  });

  it("absent clipboard API (navigator.clipboard undefined) shows the failure line", async () => {
    // beforeEach cloned navigator and assigned a clipboard; remove it so
    // the API itself is absent (early/test environments posture).
    delete (navigator as { clipboard?: unknown }).clipboard;
    (window as SyncDiagWindow).__vhSyncDiag = () => SNAPSHOT;
    render(() => <DiagLogDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /copy all/i }));
    await vi.waitFor(() => expect(statusText()).toBe(FAIL_MSG));
  });

  it("retry recovery: a new attempt clears prior status and the latest attempt's result wins", async () => {
    (window as SyncDiagWindow).__vhSyncDiag = () => SNAPSHOT;
    // Attempt 1 rejects (settles immediately); attempt 2 resolves on a
    // deferred we control, so the "cleared at attempt start" window is
    // observable before it settles.
    let resolveSecond!: (v: string) => void;
    const writeText = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("denied");
      })
      .mockImplementationOnce(() => new Promise<string>((res) => (resolveSecond = res)));
    Object.assign(navigator, { clipboard: { writeText } });
    render(() => <DiagLogDialog onClose={() => {}} />);
    const btn = screen.getByRole("button", { name: /copy all/i });
    fireEvent.click(btn); // attempt 1 → failure
    await vi.waitFor(() => expect(statusText()).toBe(FAIL_MSG));
    fireEvent.click(btn); // attempt 2 starts → prior status cleared synchronously
    expect(statusText()).toBeNull();
    resolveSecond(""); // attempt 2 settles → success
    await vi.waitFor(() => expect(statusText()).toBe("Snapshot copied."));
  });

  it("attempt token: an earlier attempt settling AFTER a newer success cannot clobber it", async () => {
    (window as SyncDiagWindow).__vhSyncDiag = () => SNAPSHOT;
    // Attempt 1 hangs on a deferred rejection; attempt 2 resolves
    // immediately. Attempt 1's rejection then lands LATE — the token guard
    // must keep attempt 2's success on screen.
    let rejectFirst!: (e: unknown) => void;
    const writeText = vi
      .fn()
      .mockImplementationOnce(() => new Promise<string>((_res, rej) => (rejectFirst = rej)))
      .mockImplementationOnce(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(() => <DiagLogDialog onClose={() => {}} />);
    const btn = screen.getByRole("button", { name: /copy all/i });
    fireEvent.click(btn); // attempt 1 (pending)
    fireEvent.click(btn); // attempt 2 → success
    await vi.waitFor(() => expect(statusText()).toBe("Snapshot copied."));
    rejectFirst(new Error("late denial"));
    await flush();
    expect(statusText()).toBe("Snapshot copied.");
  });

  it("reopen resets: fresh mount shows no stale status and a prior late-resolving attempt does not repopulate", async () => {
    (window as SyncDiagWindow).__vhSyncDiag = () => SNAPSHOT;
    // Controllable deferred (NOT setTimeout): rejecting it runs the prior
    // instance's catch in MICROTASKS, so the flush() below observably lands
    // the late rejection inside the assertion window while the second
    // instance is mounted (a microtask-only flush never reaches the timer
    // phase, so a setTimeout rejection would settle only after the final
    // assert — vacuously green).
    let rejectFirst!: (e: unknown) => void;
    const writeText = vi
      .fn()
      .mockImplementation(() => new Promise<string>((_res, rej) => (rejectFirst = rej)));
    Object.assign(navigator, { clipboard: { writeText } });
    const first = render(() => <DiagLogDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /copy all/i })); // pending
    first.unmount(); // close the dialog before the write settles
    // reopen — a FRESH instance (App mounts the dialog under <Show>); no
    // stale status may carry over.
    const second = render(() => <DiagLogDialog onClose={() => {}} />);
    expect(statusText()).toBeNull();
    rejectFirst(new Error("late denial")); // prior attempt settles after close
    await flush(); // rejection propagates through the prior instance's catch
    expect(statusText()).toBeNull(); // must not repopulate the new instance
    second.unmount();
  });
});
