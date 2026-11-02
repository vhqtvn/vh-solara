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
