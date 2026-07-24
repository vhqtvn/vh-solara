// @vitest-environment jsdom
//
// Inline-attachment MODE resolver + vision predicate + user pref (S2).
//
// effectiveInline(modelHasVision, userForcedInline) = !modelHasVision || userForcedInline:
//   - non-vision model -> inline ON (default)
//   - vision model     -> inline OFF (current chip->image-part behavior preserved)
//   - vision + pref on -> inline ON (user-forced)
//
// modelHasVision(model) is a pure predicate over the ModelRef.vision capability
// flag (populated in models.ts from `cap.attachment || cap.input?.image`). The
// pref vh.prefs.inlineAttach.v1 (default OFF) mirrors vh.prefs.queueMode.v1.
//
// S2 ONLY: no token/caret-insert/markdown/orphan/buildParts/upload-timing
// behavior is asserted here — those are S3-S5.
import { beforeEach, describe, expect, it } from "vitest";
import { loadVersioned, saveVersioned } from "../../src/lib/store";
import {
  effectiveInline,
  modelHasVision,
  inlineAttachForced,
  setInlineAttachForced,
} from "../../src/lib/inlineAttach";

// In-memory localStorage for the node test env (matches store.test.ts /
// queue.test.ts). Assigned after import, so the module-level pref signal
// initializes against an empty/undefined store (default OFF); the setter then
// writes through this shim so round-trip/envelope assertions can inspect `mem`.
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => (k in mem ? mem[k] : null),
  setItem: (k: string, v: string) => {
    mem[k] = v;
  },
  removeItem: (k: string) => {
    delete mem[k];
  },
};

const LS_INLINE_ATTACH = "vh.prefs.inlineAttach.v1";

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
});

describe("effectiveInline — pure mode resolver", () => {
  it("non-vision model -> inline ON (default)", () => {
    expect(effectiveInline(false, false)).toBe(true);
  });

  it("vision model, pref off -> inline OFF (current behavior preserved)", () => {
    expect(effectiveInline(true, false)).toBe(false);
  });

  it("vision model, pref on -> inline ON (user-forced)", () => {
    expect(effectiveInline(true, true)).toBe(true);
  });

  it("non-vision model, pref on -> inline ON (pref is a no-op here)", () => {
    expect(effectiveInline(false, true)).toBe(true);
  });
});

describe("modelHasVision — pure predicate over the vision capability flag", () => {
  it("true for a model whose catalog entry carries vision", () => {
    expect(modelHasVision({ vision: true })).toBe(true);
  });

  it("false for a non-vision model (e.g. GLM-5.2)", () => {
    expect(modelHasVision({ vision: false })).toBe(false);
  });

  it("false when the flag is absent", () => {
    expect(modelHasVision({})).toBe(false);
  });

  it("false for null/undefined (no model resolved)", () => {
    expect(modelHasVision(undefined)).toBe(false);
    expect(modelHasVision(null)).toBe(false);
  });
});

describe("inlineAttachForced pref (mirrors vh.prefs.queueMode.v1)", () => {
  it("is a boolean signal that round-trips through setInlineAttachForced", () => {
    expect(typeof inlineAttachForced()).toBe("boolean");
    setInlineAttachForced(true);
    expect(inlineAttachForced()).toBe(true);
    setInlineAttachForced(false);
    expect(inlineAttachForced()).toBe(false);
    expect(mem[LS_INLINE_ATTACH]).toBeDefined();
  });

  it("defaults off when the pref is unset (loadVersioned fallback)", () => {
    delete mem[LS_INLINE_ATTACH];
    expect(
      loadVersioned(LS_INLINE_ATTACH, 1, false, (o) => o === 1 || o === "1" || o === true),
    ).toBe(false);
  });

  it("persists in the versioned envelope shape", () => {
    saveVersioned(LS_INLINE_ATTACH, 1, true);
    expect(JSON.parse(mem[LS_INLINE_ATTACH])).toEqual({ v: 1, data: true });
  });
});
