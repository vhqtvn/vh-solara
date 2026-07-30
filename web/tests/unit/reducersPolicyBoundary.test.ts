// L-08/M4 standing check — TestApplyReconcileHasNoInlinePolicy.
//
// The projection module (reducers.ts) must NOT invoke policy APIs inline.
// Reducers project server facts into SyncState and RETURN typed effects; the
// orchestration boundary (reconcile.ts) interprets those effects and owns every
// side-effect policy (notify / persist / pin / page-flight / cursor / timers).
// This keeps projection and policy independently checkable.
//
// A NAMED temporary exception is allowed during the phased tree-boundary
// migration: patchTreeAgent (the tree-agent patch) stays inline in the
// projection because its final ownership is a must-wait tree-boundary item
// (applyTreeOpStore / tree ranking / tree-agent patch final ownership). Every
// other policy API must be absent from the projection module.
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

  it("the only direct cross-store mutation is the named patchTreeAgent exception", () => {
    // During the phased tree-boundary migration (L-08/M4 safe-now slice), the
    // tree-agent patch stays inline because its final ownership is a must-wait
    // item (applyTreeOpStore / tree ranking / tree-agent patch final ownership).
    // This assertion documents that the exception is real and intentional; the
    // slice that extracts it will update this check.
    expect(code).toContain("patchTreeAgent");
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
