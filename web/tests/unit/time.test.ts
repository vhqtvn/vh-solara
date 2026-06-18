import { describe, expect, it } from "vitest";
import { formatAgo, formatDuration, formatShort } from "../../src/lib/time";

const NOW = 1_000_000_000_000;
const ago = (sec: number) => NOW - sec * 1000;

describe("formatAgo", () => {
  it("collapses sub-minute to 'just now' (refresh is the 15s tick, not per-second)", () => {
    expect(formatAgo(ago(0), NOW)).toBe("just now");
    expect(formatAgo(ago(13), NOW)).toBe("just now");
    expect(formatAgo(ago(59), NOW)).toBe("just now");
  });
  it("shows coarser units once past a minute", () => {
    expect(formatAgo(ago(60), NOW)).toBe("1m ago");
    expect(formatAgo(ago(90), NOW)).toBe("2m ago"); // rounds
    expect(formatAgo(ago(3600), NOW)).toBe("1h ago");
    expect(formatAgo(ago(86_400), NOW)).toBe("1d ago");
  });
  it("returns empty for a missing timestamp and never goes negative", () => {
    expect(formatAgo(undefined, NOW)).toBe("");
    expect(formatAgo(NOW + 5000, NOW)).toBe("just now"); // clock skew -> clamp
  });
});

describe("formatShort", () => {
  it("shows 'now' under a minute", () => {
    expect(formatShort(ago(0), NOW)).toBe("now");
    expect(formatShort(ago(59), NOW)).toBe("now");
  });
  it("shows compact coarser units past a minute", () => {
    expect(formatShort(ago(60), NOW)).toBe("1m");
    expect(formatShort(ago(3600), NOW)).toBe("1h");
    expect(formatShort(ago(86_400), NOW)).toBe("1d");
  });
});

describe("formatDuration", () => {
  it("keeps seconds — callers that show this tick per-second", () => {
    expect(formatDuration(13_000)).toBe("13s");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(3_660_000)).toBe("1h 1m");
  });
});
