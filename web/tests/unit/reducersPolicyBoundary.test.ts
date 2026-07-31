// L-08/M4 standing check — TestApplyReconcileHasNoInlinePolicy.
//
// The projection module (reducers.ts) must NOT invoke policy APIs inline, NOR
// perform any direct cross-store mutation. Reducers project server facts into
// SyncState and RETURN typed effects; the orchestration boundary (reconcile.ts)
// interprets those effects and owns every side-effect policy (notify / persist
// / pin / page-flight / cursor / timers) AND every cross-store mutation
// (patchTreeAgent — the tree-agent patch — recorded as a reconcile-tree-agent
// effect). This keeps projection and policy independently checkable.
//
// Modeled on wire-field-aliases.test.ts (readFileSync source scan).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "..", "src"); // web/src
const reducersPath = path.join(src, "sync", "reducers.ts");

// Policy APIs the projection must NOT import or invoke inline. If the projection
// needs a side-effect, it returns an effect and orchestration performs it.
const FORBIDDEN = [
  "pushNotification", // notification dispatch
  "markRead", // notification dispatch
  "dropPinnedSession", // pin-store mutation
  "resetPageInFlight", // page-flight/cache service
  "persist", // persistence scheduling
  "maybeNotifyRootDone", // notification orchestration
  "maybeClearWaiting", // notification orchestration
  "notifyFromMessage", // notification orchestration
  "localStorage", // storage API
  "setTimeout", // policy timers
  "clearTimeout", // policy timers
  "queueMicrotask", // microtask coalescing
];

// Strip // line comments so that conceptual mentions of policy APIs in prose do
// not produce false positives. The projection module contains no string literal
// that embeds `//` followed by a forbidden identifier, so line-comment stripping
// is robust here. (If a future projection module uses block comments containing
// forbidden identifiers, extend this.)
function stripLineComments(s: string): string {
  return s
    .split(/\r?\n/)
    .map((line) => {
      const i = line.indexOf("//");
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join("\n");
}

describe("TestApplyReconcileHasNoInlinePolicy (L-08/M4)", () => {
  const reducersSrc = readFileSync(reducersPath, "utf8");
  const code = stripLineComments(reducersSrc);

  it("projection module invokes no inline policy APIs", () => {
    const hits: string[] = [];
    for (const name of FORBIDDEN) {
      if (new RegExp(`\\b${name}\\b`).test(code)) hits.push(name);
    }
    expect(
      hits,
      `reducers.ts still invokes policy APIs inline: ${hits.join(", ")}`,
    ).toEqual([]);
  });

  it("the projection performs no direct cross-store tree mutation (no patchTreeAgent)", () => {
    // The tree-agent patch was formerly a named inline exception in the
    // projection. It is now recorded as a reconcile-tree-agent effect and
    // interpreted by orchestration (reconcile.ts), so the projection must NOT
    // import or invoke patchTreeAgent at all. This assertion pins that the
    // reducer boundary stays pure projection.
    expect(
      code,
      "reducers.ts references patchTreeAgent — it must record a reconcile-tree-agent effect instead",
    ).not.toContain("patchTreeAgent");
  });

  it("projection module does not import the orchestration/policy modules", () => {
    const importLines = reducersSrc
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith("import"));
    const forbiddenModules = [
      /from "\.\.\/notify"/,
      /from "\.\.\/pins"/,
      /from "\.\/orchestration"/,
      /from "\.\/reconcile"/,
    ];
    const hits: string[] = [];
    for (const line of importLines) {
      for (const re of forbiddenModules) {
        if (re.test(line)) hits.push(line.trim());
      }
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });

  it("projection module reaches the store only via the produce draft (type-only store import)", () => {
    // The projection mutates the DRAFT `s` passed by orchestration's
    // setState(produce(...)); it must not reach the singleton store's runtime
    // state/setState/persist. The store import must be `import type` only.
    const storeImports = reducersSrc
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith("import") && /from "\.\/store"/.test(l));
    expect(storeImports.length, "expected exactly one store import").toBe(1);
    expect(storeImports[0].trim().startsWith("import type")).toBe(true);
  });
});
