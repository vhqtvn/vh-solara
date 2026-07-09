import { describe, expect, it } from "vitest";
import { filterProjectRows, ProjectActivityRow } from "../../src/projects";

// Pure-logic tests for the project switcher's search filter. No DOM: the input
// is a row list ({ name, directory }) and a query string. Covers: empty/whitespace
// query is a no-op, case-insensitive match on name, case-insensitive match on
// directory, substring (not just prefix) match, name-OR-directory semantics,
// whitespace trimming, and that matched rows are returned by reference.

const R = (name: string, directory: string): ProjectActivityRow => ({
  name,
  directory,
  running: 0,
  idle: 0,
  active: false,
});

const ROWS: ProjectActivityRow[] = [
  R("Default project", ""),
  R("alpha", "/work/alpha"),
  R("Beta", "/work/Beta"),
  R("gamma", "/home/you/gamma"),
];

describe("filterProjectRows", () => {
  it("returns the input array unchanged for an empty query (no-op)", () => {
    const out = filterProjectRows(ROWS, "");
    expect(out).toBe(ROWS); // same reference — idle dialog never rebuilds
    expect(out).toHaveLength(ROWS.length);
  });

  it("treats a whitespace-only query as empty (no-op)", () => {
    expect(filterProjectRows(ROWS, "   ")).toBe(ROWS);
    expect(filterProjectRows(ROWS, "\t\n")).toBe(ROWS);
  });

  it("matches case-insensitively by name", () => {
    // "ALPHA" matches the row whose name is "alpha".
    const out = filterProjectRows(ROWS, "ALPHA");
    expect(out.map((r) => r.name)).toEqual(["alpha"]);
  });

  it("matches case-insensitively by directory", () => {
    // "/work/beta" matches the row with directory "/work/Beta" (case differs).
    const out = filterProjectRows(ROWS, "/work/beta");
    expect(out.map((r) => r.name)).toEqual(["Beta"]);
  });

  it("matches on a substring, not just a prefix (name and directory)", () => {
    // "amm" is a substring of name "gamma".
    expect(filterProjectRows(ROWS, "amm").map((r) => r.name)).toEqual(["gamma"]);
    // "you" is a substring of directory "/home/you/gamma".
    expect(filterProjectRows(ROWS, "you").map((r) => r.name)).toEqual(["gamma"]);
  });

  it("keeps a row when EITHER name OR directory matches", () => {
    // "work" appears only in directories (/work/alpha, /work/Beta), never in a
    // name — both those rows must survive, others dropped.
    const out = filterProjectRows(ROWS, "work").map((r) => r.name).sort();
    expect(out).toEqual(["Beta", "alpha"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterProjectRows(ROWS, "zzzznomatch")).toEqual([]);
  });

  it("trims leading/trailing whitespace from the query before matching", () => {
    // "  alpha  " should behave identically to "alpha".
    expect(filterProjectRows(ROWS, "  alpha  ").map((r) => r.name)).toEqual(["alpha"]);
  });

  it("returns the matched row objects by reference (no cloning)", () => {
    const out = filterProjectRows(ROWS, "alpha");
    expect(out[0]).toBe(ROWS[1]); // identity preserved
  });

  it("matches the empty-directory default project by its name only", () => {
    // The default project has directory "" — a query of "default" matches its
    // name; a query of "" is the no-op above, not a directory match.
    const out = filterProjectRows(ROWS, "default");
    expect(out.map((r) => r.name)).toEqual(["Default project"]);
  });

  it("is case-insensitive on directory even when the name differs in case", () => {
    // Query "GAMMA" (upper) vs directory "/home/you/gamma" (lower) → match.
    expect(filterProjectRows(ROWS, "GAMMA").map((r) => r.name)).toEqual(["gamma"]);
  });

  it("tolerates a null/undefined query as empty (defensive)", () => {
    expect(filterProjectRows(ROWS, null as unknown as string)).toBe(ROWS);
    expect(filterProjectRows(ROWS, undefined as unknown as string)).toBe(ROWS);
  });
});
