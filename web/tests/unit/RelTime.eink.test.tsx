// @vitest-environment jsdom
// jsdom lacks matchMedia; import the shared stub BEFORE the component import
// is evaluated (see _matchMedia.ts).
import "./_matchMedia";
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RelTime from "../../src/components/RelTime";
import { einkProfile, setEinkProfile } from "../../src/prefs";
import { formatShort } from "../../src/lib/time";

// E-ink display profile (UX Slice 4 — quiet UI): the RelTime label's
// profile-scoped quieting contract, at the component seam with FAKE TIMERS
// (Date faked too, so formatShort bucket transitions are driven by timer
// advances exactly as by wall-clock minutes).
//
// Contract under test:
//   OFF (default): the shared 15s tick re-renders the label (unchanged
//     pre-profile behavior — byte-identical ticking).
//   ON: the label does NOT register with the shared interval — the rendered
//     text freezes even as minutes pass (no gratuitous periodic repaint),
//     while MEANINGFUL updates are preserved: an `ms` change (data update)
//     and a profile toggle both refresh the label immediately.

const T0 = 1_700_000_000_000; // a fixed epoch; only differences matter

function textOf(container: HTMLElement): string {
  return (container.querySelector("span")?.textContent ?? "").trim();
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  cleanup();
  setEinkProfile(false);
  localStorage.clear();
  vi.useRealTimers();
});

describe("RelTime — e-ink profile OFF (baseline unchanged: shared tick drives the label)", () => {
  it("re-renders on the shared 15s tick as the bucket crosses", async () => {
    expect(einkProfile()).toBe(false);
    const ms = T0 - 89_000; // 89s old → "1m"; one tick later → 104s → "2m"
    const { container } = render(() => <RelTime ms={ms} />);
    expect(textOf(container)).toBe("1m");

    await vi.advanceTimersByTimeAsync(15_000); // one shared tick
    expect(textOf(container)).toBe("2m");
  });
});

describe("RelTime — e-ink profile ON (quiet: no periodic re-render)", () => {
  beforeEach(() => {
    setEinkProfile(true);
  });

  it("renders once and stays quiet as minutes pass (no tick registration)", async () => {
    expect(einkProfile()).toBe(true);
    const ms = T0 - 89_000;
    const { container } = render(() => <RelTime ms={ms} />);
    expect(textOf(container)).toBe("1m");

    // Four tick periods + change: without registration the label is frozen…
    await vi.advanceTimersByTimeAsync(65_000);
    expect(textOf(container)).toBe("1m");
    // …while the same elapsed time WOULD have re-bucketed by now (sanity:
    // the frozen label is staleness by design, not a formatter artifact).
    expect(formatShort(ms, Date.now())).toBe("3m");
  });

  it("preserves meaningful updates: an ms change refreshes immediately under ON", async () => {
    const [ms, setMs] = createSignal(T0 - 89_000);
    const { container } = render(() => <RelTime ms={ms()} />);
    expect(textOf(container)).toBe("1m");

    // The underlying timestamp changes (a session/message update): the label
    // follows at once — quiet ≠ silent.
    await vi.advanceTimersByTimeAsync(3_000);
    setMs(Date.now() - 185_000); // 185s old → "3m"
    expect(textOf(container)).toBe("3m");
    // …and it stays quiet afterwards.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(textOf(container)).toBe("3m");
  });

  it("toggles live: ON freezes after one catch-up refresh; OFF resumes the shared tick", async () => {
    setEinkProfile(false); // this describe's beforeEach set ON; the toggle test starts from OFF
    const ms = T0 - 89_000;
    const { container } = render(() => <RelTime ms={ms} />);
    expect(textOf(container)).toBe("1m");

    // OFF for 45s: the shared ticks legitimately move the label (134s → 2m).
    await vi.advanceTimersByTimeAsync(45_000);
    expect(textOf(container)).toBe("2m");

    // OFF → ON mid-life: one meaningful catch-up at the moment the interval
    // goes quiet, then stillness.
    setEinkProfile(true);
    expect(textOf(container)).toBe(formatShort(ms, Date.now()));
    const frozen = textOf(container);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(textOf(container)).toBe(frozen); // quiet under ON

    // ON → OFF: registration resumes; the next tick moves the label again.
    setEinkProfile(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(textOf(container)).not.toBe(frozen);
  });
});
