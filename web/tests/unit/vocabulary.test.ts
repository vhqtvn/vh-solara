// Standing check for audit L-02 / remediation M11 (TS half).
//
// The client per-session "Stream 2 has delivered this session to me" state map
// was renamed messagesLoaded -> messagesDelivered to stop colliding with the
// aggregator's hydration-completion fact (which implied equivalent completion
// across layers despite describing materially different states). The SERVER wire
// GateFacts.messagesLoaded field is INTENTIONALLY unchanged (it is the
// daemon-side fetch memo, a different fact); only the client-state identifier
// was renamed.
//
// This pins: (1) no client-state access under the old name survives in web/src,
// (2) the renamed map exists, (3) the wire field is preserved. (The Go half —
// aggregator hydratedOnce -> anyHydrateCompleted — is pinned by
// TestVocabularyMessagesDeliveredAndAnyHydrate in pkg/aggregator.)
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

describe("vocabulary: messagesDelivered + anyHydrateCompleted (L-02/M11)", () => {
  const files = walk(src);

  it("has zero client-state messagesLoaded accesses (renamed to messagesDelivered)", () => {
    // Client-state access patterns only. The lookbehind ensures `s.`/`state.`
    // are standalone identifiers (not e.g. `this.` or a suffix of `gate.`), so
    // wire-field reads like `snap.gate?.[id]?.messagesLoaded` and gate fixtures
    // (`gate: { s1: { messagesLoaded: true } }`) are correctly NOT flagged.
    const clientStateAccess = /(?<![\w$])(?:state|s)\.messagesLoaded\b|setState\("messagesLoaded"/;
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (clientStateAccess.test(line)) hits.push(`${path.relative(src, f)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });

  it("declares the renamed client-state map messagesDelivered (and not the old field)", () => {
    const store = readFileSync(path.join(src, "sync", "store.ts"), "utf8");
    expect(store).toContain("messagesDelivered: Record<string, boolean>");
    expect(store).not.toContain("messagesLoaded: Record<string, boolean>");
  });

  it("preserves the wire GateFacts.messagesLoaded field (server response spelling unchanged)", () => {
    const types = readFileSync(path.join(src, "types.ts"), "utf8");
    expect(types).toContain("messagesLoaded?: boolean;");
  });
});
