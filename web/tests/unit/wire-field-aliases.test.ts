// Standing checks for audit L-03 / L-09 / L-10 (TS half, Posture B
// alias-during-transition).
//
// The daemon DUAL-EMITS old + new wire field names with the SAME value. The SPA
// MIGRATES to read the exact names (`hasMessages`, `runningRoots`); the retained
// old names (`hydrated`, `running`) stay on the wire for a stale un-reloaded
// tab. These tests pin:
//   - the SPA reads the NEW wire names (positive),
//   - the SPA does NOT read the OLD wire names as DTO access expressions
//     (negative, regression gate against a revert),
//   - both old + new names stay DECLARED on the wire DTOs (compat retention).
//
// The Go half (dual-emit presence + value identity) is pinned by
// TestGateDualEmitsHydratedAndHasMessages / TestGateDualEmitsPermissionBlocked
// in pkg/state and TestProjectsDualEmitsRunningAndRunningRoots in pkg/web.
// See docs/ai/wire-field-deprecation.md for the removal/cutoff policy.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "..", "src"); // web/src

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(name)) acc.push(p);
  }
  return acc;
}

describe("wire-field aliases: hasMessages / permissionWasBlocked / runningRoots (L-03/L-09/L-10)", () => {
  const files = walk(src);
  const projectsTs = readFileSync(path.join(src, "projects.ts"), "utf8");
  const reducersTs = readFileSync(path.join(src, "sync", "reducers.ts"), "utf8");
  const typesTs = readFileSync(path.join(src, "types.ts"), "utf8");

  // ---- L-03: hydrated -> hasMessages (snapshot.gate) ----

  it("SPA reads the NEW gate field `hasMessages` (not the old `hydrated`)", () => {
    // The reducer's resync-window check reads the exact name. After migration
    // the source reads `g.hasMessages === false`; the old `g.hydrated` access
    // must not survive anywhere in web/src as a DTO property read.
    expect(reducersTs).toContain("g.hasMessages === false");

    // No dot-access of the old gate field survives in web/src. A leading dot
    // (`g.hydrated`, `gate.hydrated`) is how the field is read; type
    // declarations (`hydrated?:`) and prose (`` `hydrated` ``) carry no dot and
    // are correctly not flagged. (L-09's `permission_blocked` has no SPA read at
    // all, so it is not asserted here.)
    const hydratedDotAccess = /\.hydrated\b/;
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (hydratedDotAccess.test(line))
            hits.push(`${path.relative(src, f)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });

  it("GateFacts declares BOTH the new `hasMessages` and the retained `hydrated` (compat)", () => {
    expect(typesTs).toContain("hasMessages?: boolean;");
    expect(typesTs).toContain("hydrated?: boolean;"); // retained on the wire
  });

  // ---- L-10: running -> runningRoots (/vh/projects) ----

  it("ProjectEndpointItem declares BOTH the new `runningRoots` and the retained `running` (compat)", () => {
    expect(projectsTs).toContain("runningRoots: number;");
    expect(projectsTs).toContain("running: number;"); // retained on the wire
  });

  it("buildActivityMaps reads the NEW field `runningRoots` (not the old wire `running`)", () => {
    // buildActivityMaps is the ONLY consumer of the /vh/projects wire DTO. It
    // must read `p.runningRoots` (the exact name). Extract the function body
    // (from its declaration to the next exported function) and assert:
    //   - it reads the new field, and
    //   - it does NOT read the old wire field `p.running` (a bare dot-access;
    //     `p.runningRoots` does not match because there is no word boundary
    //     between `running` and `Roots`).
    const start = projectsTs.indexOf("export function buildActivityMaps(");
    expect(start, "buildActivityMaps must exist in projects.ts").toBeGreaterThanOrEqual(0);
    const nextFn = projectsTs.indexOf("export function", start + 1);
    const body = projectsTs.slice(start, nextFn < 0 ? undefined : nextFn);
    expect(body).toContain("p.runningRoots");
    const oldWireRead = /p\.running\b/;
    expect(oldWireRead.test(body), `old wire read \`p.running\` survived in buildActivityMaps:\n${body}`).toBe(false);
  });
});
