// @vitest-environment jsdom
// jsdom doesn't implement matchMedia, but Part.tsx → code/frame → layout calls
// window.matchMedia at module load. Install a minimal stub BEFORE the component
// import is evaluated (vi.hoisted runs ahead of static imports).
vi.hoisted(() => {
  const w = globalThis as unknown as { matchMedia?: unknown };
  if (!w.matchMedia) {
    w.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }
});
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import PartView from "../../src/components/Part";
import type { Part } from "../../src/types";

// The tool-row duration slot must show a LIVE ticking elapsed while the tool is
// running (start set, no end) and settle to the final total once it ends —
// mirroring the Thinking (reasoning) block's timer. Before the change the slot
// stayed blank while running. We mount PartView (the dispatcher → ToolPart for
// type "tool") and drive the per-row setInterval with fake timers so the tick
// is deterministic.

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function toolPart(overrides: Partial<Part> = {}, state: Record<string, unknown> = {}): Part {
  return {
    id: "p1",
    sessionID: "s1",
    messageID: "m1",
    type: "tool",
    tool: "bash",
    state,
    ...overrides,
  } as Part;
}

function durEl(container: HTMLElement): HTMLElement {
  const el = container.querySelector(".tool-dur");
  if (!el) throw new Error(".tool-dur not rendered");
  return el as HTMLElement;
}

describe("ToolPart live duration", () => {
  it("ticks elapsed seconds while running and marks the slot .live", async () => {
    // Freeze the clock at BASE; the tool started exactly at BASE (0s elapsed).
    const BASE = 1_700_000_000_000;
    vi.setSystemTime(BASE);
    const part = toolPart({}, { status: "running", time: { start: BASE } });

    const { container } = render(() => <PartView part={part} settled={false} />);

    // Initial mount: 0s elapsed, accent-tinted (.live) like the reasoning timer.
    let dur = durEl(container as unknown as HTMLElement);
    expect(dur.textContent).toBe("0s");
    expect(dur.classList.contains("live")).toBe(true);

    // The per-row setInterval(…, 1000) advances the elapsed text whole seconds.
    await vi.advanceTimersByTimeAsync(1000);
    expect(durEl(container as unknown as HTMLElement).textContent).toBe("1s");

    await vi.advanceTimersByTimeAsync(4000); // 1s + 4s = 5s total
    expect(durEl(container as unknown as HTMLElement).textContent).toBe("5s");
  });

  it("settles to the sub-second-precise final duration once the tool ends (no .live)", () => {
    const start = 1_000;
    const end = start + 3500; // 3.5s — exercises durationText's toFixed(1) path
    const part = toolPart({}, { status: "completed", time: { start, end } });

    const { container } = render(() => <PartView part={part} settled={true} />);

    const dur = durEl(container as unknown as HTMLElement);
    expect(dur.textContent).toBe("3.5s");
    expect(dur.classList.contains("live")).toBe(false);
  });

  it("shows nothing before a start timestamp is known (no blank/0s flash)", () => {
    // A tool that is "running" but has no start yet has nothing meaningful to
    // show — keep the slot hidden rather than flashing a bogus 0s.
    const part = toolPart({}, { status: "running" });
    const { container } = render(() => <PartView part={part} settled={false} />);
    expect((container as unknown as HTMLElement).querySelector(".tool-dur")).toBeNull();
  });
});
