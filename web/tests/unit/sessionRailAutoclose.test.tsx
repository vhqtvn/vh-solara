// @vitest-environment jsdom
//
// openSessionChat narrow-tier auto-dismiss (P1 portrait monitor) — the
// mechanical root of the auto-close crux, unit-pinned:
//
//   widthTier() === "narrow"  → selecting a session DISMISSES navOpen
//   anything else (rail/wide/null) → navOpen untouched (legacy behavior;
//   null is the kill-switch-off / pre-observation state)
//
// The full drawer interaction (open drawer → tap row → drawer closes, chat
// revealed) is e2e-proven in tests/e2e/session-rail.spec.ts; this pins the
// signal-level decision table without the DOM.
//
// shapeTier.widthTier is mocked per-case (the live signal is RO-driven);
// sync.setSelectedId is mocked out so the selection round-trip (ack POST,
// URL write) stays out of scope — setView + setNavOpen run for real.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { widthTierMock } = vi.hoisted(() => ({ widthTierMock: vi.fn() }));
vi.mock("../../src/shapeTier", async (importActual) => {
  const actual = await importActual<typeof import("../../src/shapeTier")>();
  return { ...actual, widthTier: (): "narrow" | "rail" | "wide" | null => widthTierMock() };
});
vi.mock("../../src/sync", async (importActual) => {
  const actual = await importActual<typeof import("../../src/sync")>();
  return { ...actual, setSelectedId: vi.fn() };
});

import { openSessionChat } from "../../src/components/SessionTree";
import { navOpen, setNavOpen, setView, view } from "../../src/ui";

beforeEach(() => {
  widthTierMock.mockReset();
  setNavOpen(false);
  setView("chat");
});

describe("openSessionChat narrow-tier drawer dismissal", () => {
  it("narrow: an open drawer is dismissed on select", () => {
    widthTierMock.mockReturnValue("narrow");
    setNavOpen(true);
    expect(navOpen()).toBe(true);
    openSessionChat("demo");
    expect(navOpen()).toBe(false);
  });

  it("narrow: a closed drawer stays closed (no-op, not a toggle)", () => {
    widthTierMock.mockReturnValue("narrow");
    openSessionChat("demo");
    expect(navOpen()).toBe(false);
  });

  it("rail band: navOpen untouched (the drawer never shows there)", () => {
    widthTierMock.mockReturnValue("rail");
    setNavOpen(true);
    openSessionChat("demo");
    expect(navOpen()).toBe(true);
  });

  it("wide: navOpen untouched (inline sidebar, legacy collapse semantics)", () => {
    widthTierMock.mockReturnValue("wide");
    setNavOpen(true);
    openSessionChat("demo");
    expect(navOpen()).toBe(true);
  });

  it("null tier (kill-switch off / first frame): EXACT legacy — no dismissal", () => {
    widthTierMock.mockReturnValue(null);
    setNavOpen(true);
    openSessionChat("demo");
    expect(navOpen()).toBe(true);
  });

  it("selection still snaps the view to chat in every mode", () => {
    for (const t of ["narrow", "rail", "wide", null] as const) {
      widthTierMock.mockReturnValue(t);
      openSessionChat("demo");
      expect(view()).toBe("chat");
    }
  });
});
