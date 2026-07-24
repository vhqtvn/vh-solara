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
  attachMarkdownRef,
  insertAtCaret,
  inlineAttachUrl,
  VH_ATTACH_URL_PREFIX,
  INLINE_LOCALID_PREFIX,
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

// ---------------------------------------------------------------------------
// S3: pure helpers for inline-mode attachment token insertion.
//
// attachMarkdownRef builds the markdown reference inserted at the textarea
// caret; inlineAttachUrl builds the synthetic chip url; insertAtCaret is the
// pure textarea splice+caret-advance used by ChatView's inline-mode branch.
// These are framework-free so they can be unit-tested in jsdom without mounting
// ChatView. Upload / buildParts / send-resolve / orphan handling are S4/S5.

describe("attachMarkdownRef — pure markdown ref builder", () => {
  it("image attachment -> ![filename](vh-attach:localId)", () => {
    expect(attachMarkdownRef("name.png", true, "abc")).toBe("![name.png](vh-attach:abc)");
  });

  it("non-image attachment -> [filename](vh-attach:localId) (no leading !)", () => {
    expect(attachMarkdownRef("doc.pdf", false, "abc")).toBe("[doc.pdf](vh-attach:abc)");
  });

  it("isImage alone decides the leading !, not the filename extension", () => {
    // The helper is mime-agnostic: the CALLER decides isImage via
    // mime.startsWith("image/"). A .png-flagged-non-image still gets no !...
    expect(attachMarkdownRef("weird.png", false, "x")).toBe("[weird.png](vh-attach:x)");
    // ...and a .txt-flagged-image still gets ! (caller's authority).
    expect(attachMarkdownRef("weird.txt", true, "x")).toBe("![weird.txt](vh-attach:x)");
  });

  it("passes the filename through verbatim (no sanitization in S3)", () => {
    // S3 keeps the visible label transparent (matches what the user picked).
    // Sanitization, if it ever matters, is a later slice — the ref is parsed by
    // us at send (S4), not rendered as live markdown before then.
    expect(attachMarkdownRef("my file (1).png", true, "abc")).toBe(
      "![my file (1).png](vh-attach:abc)",
    );
  });
});

describe("inlineAttachUrl — localId -> synthetic attachment url", () => {
  it("prefixes the localId with the vh-attach: scheme", () => {
    expect(inlineAttachUrl("inl3")).toBe("vh-attach:inl3");
  });

  it("the url scheme is exactly vh-attach: (no trailing slash)", () => {
    expect(inlineAttachUrl("x")).toBe("vh-attach:x");
  });

  it("the exported scheme constant matches the prefix the helper emits", () => {
    expect(VH_ATTACH_URL_PREFIX).toBe("vh-attach:");
    expect(INLINE_LOCALID_PREFIX).toBe("inl");
  });
});

describe("insertAtCaret — pure textarea splice + caret advance (jsdom)", () => {
  function mkTa(value: string, sel: number, end = sel): HTMLTextAreaElement {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.selectionStart = sel;
    ta.selectionEnd = end;
    return ta;
  }

  it("inserts text at the caret in the MIDDLE of the value and advances the caret", () => {
    const ta = mkTa("hello world", 5); // caret between "hello" and " world"
    insertAtCaret(ta, " XYZ");
    expect(ta.value).toBe("hello XYZ world");
    expect(ta.selectionStart).toBe(9); // 5 + len(" XYZ")
    expect(ta.selectionEnd).toBe(9);
  });

  it("inserts an IMAGE ref identically (the helper is mime-agnostic)", () => {
    const ta = mkTa("hello world", 5);
    insertAtCaret(ta, "![name.png](vh-attach:abc)");
    expect(ta.value).toBe("hello![name.png](vh-attach:abc) world");
    expect(ta.selectionStart).toBe(5 + "![name.png](vh-attach:abc)".length);
    expect(ta.selectionEnd).toBe(5 + "![name.png](vh-attach:abc)".length);
  });

  it("inserts a NON-IMAGE ref identically (same helper, different ref string)", () => {
    const ta = mkTa("hello world", 5);
    insertAtCaret(ta, "[doc.pdf](vh-attach:abc)");
    expect(ta.value).toBe("hello[doc.pdf](vh-attach:abc) world");
    expect(ta.selectionStart).toBe(5 + "[doc.pdf](vh-attach:abc)".length);
  });

  it("inserting TWICE advances the caret so both insertions land in order", () => {
    const ta = mkTa("ab", 1); // a|b
    insertAtCaret(ta, "X"); // -> aX|b, caret at 2
    insertAtCaret(ta, "Y"); // -> aXY|b, caret at 3
    expect(ta.value).toBe("aXYb");
    expect(ta.selectionStart).toBe(3);
    expect(ta.selectionEnd).toBe(3);
  });

  it("EDGE: selectionStart === 0 (insert at beginning)", () => {
    const ta = mkTa("abc", 0);
    insertAtCaret(ta, "Z");
    expect(ta.value).toBe("Zabc");
    expect(ta.selectionStart).toBe(1);
    expect(ta.selectionEnd).toBe(1);
  });

  it("EDGE: selectionStart === value.length (insert at end)", () => {
    const ta = mkTa("abc", 3);
    insertAtCaret(ta, "Z");
    expect(ta.value).toBe("abcZ");
    expect(ta.selectionStart).toBe(4);
    expect(ta.selectionEnd).toBe(4);
  });

  it("REPLACES the current selection (selectionStart !== selectionEnd)", () => {
    const ta = mkTa("hello world", 0, 5); // "hello" selected
    insertAtCaret(ta, "HI");
    expect(ta.value).toBe("HI world");
    expect(ta.selectionStart).toBe(2);
    expect(ta.selectionEnd).toBe(2);
  });

  it("empty-text insert leaves the value unchanged and the caret in place", () => {
    const ta = mkTa("abc", 1);
    insertAtCaret(ta, "");
    expect(ta.value).toBe("abc");
    expect(ta.selectionStart).toBe(1);
    expect(ta.selectionEnd).toBe(1);
  });
});
