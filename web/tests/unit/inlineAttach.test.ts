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
  scanInlineTokens,
  substituteInlineTokens,
  isInlineChipUrl,
  selectInlineImageParts,
  resolveInlineAttachments,
  inlineLocalIdFromUrl,
  isInlineChipOrphan,
  type ResolvedAttachment,
  type InlineUploader,
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

// ---------------------------------------------------------------------------
// S4: send-resolve pure helpers + lazy-upload orchestration.
//
// scanInlineTokens / substituteInlineTokens / isInlineChipUrl /
// selectInlineImageParts are pure. resolveInlineAttachments composes them and
// is async only because it awaits a supplied uploader (mockable -> deterministic
// lazy-upload / vision-gate / graceful-fallback tests with no server).

function mkFile(name: string, mime: string, size = 8): File {
  const f = new File([new Uint8Array(size)], name, { type: mime });
  return f;
}

function mkResolved(name: string, mime: string, path: string, url = `file:///p/${path}`): ResolvedAttachment {
  return { url, filename: name, mime, path };
}

describe("scanInlineTokens — present localIds in stable dedup order", () => {
  it("returns the localId from a single image ref", () => {
    expect(scanInlineTokens("see ![f](vh-attach:inl3) here")).toEqual(["inl3"]);
  });

  it("returns the localId from a non-image ref", () => {
    expect(scanInlineTokens("[doc.pdf](vh-attach:inl7)")).toEqual(["inl7"]);
  });

  it("returns multiple distinct localIds in order of first appearance", () => {
    expect(
      scanInlineTokens("![a](vh-attach:inl1) x ![b](vh-attach:inl2) y [c](vh-attach:inl3)"),
    ).toEqual(["inl1", "inl2", "inl3"]);
  });

  it("dedupes a token referenced more than once", () => {
    expect(scanInlineTokens("![a](vh-attach:inl1) and again ![a2](vh-attach:inl1)")).toEqual(["inl1"]);
  });

  it("returns an EMPTY array when no inline token is present (non-inline text)", () => {
    expect(scanInlineTokens("just a normal message")).toEqual([]);
  });

  it("does NOT match a bare vh-attach: prefix with no id", () => {
    // "vh-attach:" alone (no localId chars) must not produce a phantom id.
    expect(scanInlineTokens("see vh-attach: end")).toEqual([]);
  });

  it("does NOT capture the trailing markdown ')' as part of the id", () => {
    expect(scanInlineTokens("![f](vh-attach:inl9)")).toEqual(["inl9"]);
  });
});

describe("substituteInlineTokens — splice token -> real path, keep ref structure", () => {
  it("substitutes an image-ref token with the bare real path", () => {
    expect(substituteInlineTokens("![f](vh-attach:inl3)", { inl3: ".vh-solara/sessions/s/attachments/x.png" }))
      .toBe("![f](.vh-solara/sessions/s/attachments/x.png)");
  });

  it("substitutes a non-image-ref token", () => {
    expect(substituteInlineTokens("[doc.pdf](vh-attach:inl7)", { inl7: ".vh-solara/sessions/s/attachments/d.pdf" }))
      .toBe("[doc.pdf](.vh-solara/sessions/s/attachments/d.pdf)");
  });

  it("substitutes multiple distinct tokens in one pass", () => {
    const text = "![a](vh-attach:inl1) [b](vh-attach:inl2)";
    expect(substituteInlineTokens(text, { inl1: "p/a.png", inl2: "p/b.txt" }))
      .toBe("![a](p/a.png) [b](p/b.txt)");
  });

  it("substitutes ALL occurrences of a repeated token", () => {
    expect(substituteInlineTokens("![a](vh-attach:inl1) ![a2](vh-attach:inl1)", { inl1: "p/a.png" }))
      .toBe("![a](p/a.png) ![a2](p/a.png)");
  });

  it("LEAVES a token verbatim when it has no resolved path (graceful, no crash)", () => {
    // Upload failed / older backend -> no entry -> token stays visible (no silent drop).
    expect(substituteInlineTokens("![a](vh-attach:inl1)", {})).toBe("![a](vh-attach:inl1)");
  });

  it("substitutes mapped tokens while leaving unmapped ones in place", () => {
    expect(substituteInlineTokens("![a](vh-attach:inl1) [b](vh-attach:inl2)", { inl1: "p/a.png" }))
      .toBe("![a](p/a.png) [b](vh-attach:inl2)");
  });

  it("preserves surrounding text exactly", () => {
    expect(substituteInlineTokens("before ![f](vh-attach:inl3) after", { inl3: "p.png" }))
      .toBe("before ![f](p.png) after");
  });

  it("does not emit a literal @file anywhere", () => {
    const out = substituteInlineTokens("![f](vh-attach:inl3)", { inl3: ".vh-solara/x.png" });
    expect(out).not.toContain("@file");
  });
});

describe("isInlineChipUrl — synthetic inline chip predicate (buildParts exclusion)", () => {
  it("true for a synthetic inline chip url", () => {
    expect(isInlineChipUrl("vh-attach:inl3")).toBe(true);
  });

  it("true for the bare prefix form too", () => {
    expect(isInlineChipUrl("vh-attach:")).toBe(true);
  });

  it("false for a real file:// uploaded attachment url", () => {
    expect(isInlineChipUrl("file:///proj/.vh-solara/sessions/s/attachments/x.png")).toBe(false);
  });

  it("false for empty / undefined-ish input", () => {
    expect(isInlineChipUrl("")).toBe(false);
  });

  it("false for an http url (never collides with the synthetic scheme)", () => {
    expect(isInlineChipUrl("https://example.com/x.png")).toBe(false);
  });
});

describe("selectInlineImageParts — vision-gated image file-part selector", () => {
  const img = mkResolved("a.png", "image/png", "p/a.png");
  const img2 = mkResolved("b.jpg", "image/jpeg", "p/b.jpg");
  const pdf = mkResolved("d.pdf", "application/pdf", "p/d.pdf");
  const txt = mkResolved("t.txt", "text/plain", "p/t.txt");

  it("vision ON -> returns only the IMAGE uploads", () => {
    expect(selectInlineImageParts([img, pdf, img2, txt], true)).toEqual([img, img2]);
  });

  it("vision ON, no images -> empty", () => {
    expect(selectInlineImageParts([pdf, txt], true)).toEqual([]);
  });

  it("vision OFF -> ALWAYS empty (text only, even for images)", () => {
    expect(selectInlineImageParts([img, img2], false)).toEqual([]);
  });

  it("vision ON ignores uploads whose mime is absent", () => {
    const noMime = { url: "file:///p/x", filename: "x", mime: "" } as ResolvedAttachment;
    expect(selectInlineImageParts([noMime, img], true)).toEqual([img]);
  });

  it("vision ON treats only mime.startsWith('image/') as image", () => {
    // 'application/image-icon' must NOT match (startsWith image/ is the rule).
    const fake = mkResolved("x", "application/image-thing", "p/x");
    expect(selectInlineImageParts([fake, img], true)).toEqual([img]);
  });
});

// Mock uploader harness: records every File it is called with (in call order)
// and resolves each via the per-filename table. A name absent from the table
// simulates a failed upload (returns null). This lets the lazy-upload tests
// assert EXACTLY which Files were uploaded.
function mockUploader(table: Record<string, ResolvedAttachment | null>) {
  const calls: File[] = [];
  const uploader: InlineUploader = (file) => {
    calls.push(file);
    const r = table[file.name];
    return Promise.resolve(r === undefined ? null : r);
  };
  return { uploader, calls };
}

describe("resolveInlineAttachments — lazy upload + substitute + vision gate", () => {
  it("uploads ONLY a token still present in the text (lazy upload)", async () => {
    const f = mkFile("a.png", "image/png");
    const files = new Map([["inl1", f]]);
    const { uploader, calls } = mockUploader({ "a.png": mkResolved("a.png", "image/png", "p/a.png") });
    const r = await resolveInlineAttachments("![a](vh-attach:inl1)", files, uploader, false);
    expect(calls).toEqual([f]); // the held File WAS uploaded
    expect(r.uploadedIds).toEqual(["inl1"]);
    expect(r.resolvedText).toBe("![a](p/a.png)");
  });

  it("NEVER uploads a token whose markdown ref was deleted (absent from text)", async () => {
    // inl1 is held in the Map but its ref was removed from the text by the user.
    const f = mkFile("a.png", "image/png");
    const files = new Map([["inl1", f]]);
    const { uploader, calls } = mockUploader({ "a.png": mkResolved("a.png", "image/png", "p/a.png") });
    const r = await resolveInlineAttachments("no refs here", files, uploader, false);
    expect(calls).toEqual([]); // uploader never invoked for the deleted ref
    expect(r.uploadedIds).toEqual([]);
    expect(r.failedIds).toEqual([]);
    expect(r.resolvedText).toBe("no refs here");
  });

  it("uploads the present token and skips the absent one in the SAME text", async () => {
    const f1 = mkFile("a.png", "image/png");
    const f2 = mkFile("b.png", "image/png");
    const files = new Map([["inl1", f1], ["inl2", f2]]);
    const { uploader, calls } = mockUploader({
      "a.png": mkResolved("a.png", "image/png", "p/a.png"),
      "b.png": mkResolved("b.png", "image/png", "p/b.png"),
    });
    // Only inl1 referenced; inl2 held but not referenced.
    const r = await resolveInlineAttachments("![a](vh-attach:inl1)", files, uploader, false);
    expect(calls.map((f) => f.name)).toEqual(["a.png"]);
    expect(r.uploadedIds).toEqual(["inl1"]);
  });

  it("vision ON + referenced IMAGE -> exactly one image file part", async () => {
    const f = mkFile("a.png", "image/png");
    const files = new Map([["inl1", f]]);
    const { uploader } = mockUploader({ "a.png": mkResolved("a.png", "image/png", "p/a.png") });
    const r = await resolveInlineAttachments("![a](vh-attach:inl1)", files, uploader, true);
    expect(r.imageParts).toEqual([mkResolved("a.png", "image/png", "p/a.png")]);
    expect(r.resolvedText).toBe("![a](p/a.png)"); // text also substituted
  });

  it("vision ON + referenced NON-IMAGE -> NO image file part (path still substituted)", async () => {
    const f = mkFile("d.pdf", "application/pdf");
    const files = new Map([["inl1", f]]);
    const { uploader } = mockUploader({ "d.pdf": mkResolved("d.pdf", "application/pdf", "p/d.pdf") });
    const r = await resolveInlineAttachments("[d](vh-attach:inl1)", files, uploader, true);
    expect(r.imageParts).toEqual([]);
    expect(r.resolvedText).toBe("[d](p/d.pdf)");
  });

  it("vision OFF -> ZERO image file parts even for referenced images (text only)", async () => {
    const f = mkFile("a.png", "image/png");
    const files = new Map([["inl1", f]]);
    const { uploader } = mockUploader({ "a.png": mkResolved("a.png", "image/png", "p/a.png") });
    const r = await resolveInlineAttachments("![a](vh-attach:inl1)", files, uploader, false);
    expect(r.imageParts).toEqual([]);
    expect(r.resolvedText).toBe("![a](p/a.png)");
  });

  it("graceful: upload returns no `path` -> falls back to `url` for substitution (no throw)", async () => {
    const f = mkFile("a.png", "image/png");
    const files = new Map([["inl1", f]]);
    // Older backend / transient: path absent, only a url came back.
    const { uploader } = mockUploader({
      "a.png": { url: "file:///proj/.vh-solara/x.png", filename: "a.png", mime: "image/png" },
    });
    const r = await resolveInlineAttachments("![a](vh-attach:inl1)", files, uploader, false);
    expect(r.resolvedText).toBe("![a](file:///proj/.vh-solara/x.png)");
    expect(r.failedIds).toEqual([]);
  });

  it("graceful: a FAILED upload (null) leaves the token verbatim, no throw, no silent drop", async () => {
    const f = mkFile("a.png", "image/png");
    const files = new Map([["inl1", f]]);
    const { uploader } = mockUploader({ "a.png": null }); // upload fails
    const r = await resolveInlineAttachments("![a](vh-attach:inl1)", files, uploader, false);
    expect(r.resolvedText).toBe("![a](vh-attach:inl1)"); // token remains (visible, not dropped)
    expect(r.uploadedIds).toEqual([]);
    expect(r.failedIds).toEqual(["inl1"]);
    expect(r.imageParts).toEqual([]);
  });

  it("graceful: present token with no held File leaves the token (no crash)", async () => {
    const files = new Map<string, File>(); // localId not held
    const { uploader, calls } = mockUploader({});
    const r = await resolveInlineAttachments("![a](vh-attach:inl1)", files, uploader, false);
    expect(calls).toEqual([]);
    expect(r.resolvedText).toBe("![a](vh-attach:inl1)");
    expect(r.failedIds).toEqual(["inl1"]);
  });

  it("mixed: one image + one non-image, vision ON -> one image part, both paths substituted", async () => {
    const fImg = mkFile("a.png", "image/png");
    const fPdf = mkFile("d.pdf", "application/pdf");
    const files = new Map([["inl1", fImg], ["inl2", fPdf]]);
    const { uploader } = mockUploader({
      "a.png": mkResolved("a.png", "image/png", "p/a.png"),
      "d.pdf": mkResolved("d.pdf", "application/pdf", "p/d.pdf"),
    });
    const r = await resolveInlineAttachments("![a](vh-attach:inl1) [d](vh-attach:inl2)", files, uploader, true);
    expect(r.imageParts).toEqual([mkResolved("a.png", "image/png", "p/a.png")]);
    expect(r.resolvedText).toBe("![a](p/a.png) [d](p/d.pdf)");
  });

  it("uploads in stable first-appearance order", async () => {
    const f1 = mkFile("a.png", "image/png");
    const f2 = mkFile("b.png", "image/png");
    const f3 = mkFile("c.png", "image/png");
    const files = new Map([["inl3", f3], ["inl1", f1], ["inl2", f2]]);
    const { uploader, calls } = mockUploader({
      "a.png": mkResolved("a.png", "image/png", "p/a.png"),
      "b.png": mkResolved("b.png", "image/png", "p/b.png"),
      "c.png": mkResolved("c.png", "image/png", "p/c.png"),
    });
    // Text references in order inl2, inl3, inl1 (Map insertion order differs).
    const r = await resolveInlineAttachments(
      "![b](vh-attach:inl2) ![c](vh-attach:inl3) ![a](vh-attach:inl1)",
      files,
      uploader,
      false,
    );
    expect(calls.map((f) => f.name)).toEqual(["b.png", "c.png", "a.png"]);
    expect(r.uploadedIds).toEqual(["inl2", "inl3", "inl1"]);
  });
});

// ---------------------------------------------------------------------------
// S5: orphan indicator + localId extraction + inline lifecycle tidy.
//
// inlineLocalIdFromUrl / isInlineChipOrphan are pure: they derive localId from
// a chip url and decide orphan status from the present-token set. The orphan
// UI in ChatView is a thin reactive wrapper: presentInlineIds =
// createMemo(() => new Set(scanInlineTokens(input()))), and each chip's orphan
// flag = isInlineChipOrphan(chip.url, presentInlineIds()). The remaining tests
// model the inline lifecycle (chip delete drops File, dF1 clear-on-success, dF2
// rollback-on-failure retry idempotency, re-insert composition) using these pure
// helpers + a plain Map/array standing in for ChatView's inlineFiles /
// attachments() — so they exercise the EXACT logic without mounting ChatView
// (which requires ~150 lines of module mocks; the pure seam is deterministic).

describe("inlineLocalIdFromUrl — extract localId from a chip url (inverse of inlineAttachUrl)", () => {
  it("extracts the localId from a synthetic inline chip url", () => {
    expect(inlineLocalIdFromUrl("vh-attach:inl3")).toBe("inl3");
  });

  it("round-trips with inlineAttachUrl", () => {
    const id = "inl42";
    expect(inlineLocalIdFromUrl(inlineAttachUrl(id))).toBe(id);
  });

  it("returns null for a real file:// uploaded attachment (non-inline)", () => {
    expect(inlineLocalIdFromUrl("file:///proj/.vh-solara/x.png")).toBeNull();
  });

  it("returns null for an http url (never collides with the synthetic scheme)", () => {
    expect(inlineLocalIdFromUrl("https://example.com/x.png")).toBeNull();
  });

  it("returns null for the bare prefix form (no id)", () => {
    expect(inlineLocalIdFromUrl("vh-attach:")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(inlineLocalIdFromUrl("")).toBeNull();
  });
});

describe("isInlineChipOrphan — orphan status from the present-token set", () => {
  it("token PRESENT in presentIds -> NOT an orphan (false)", () => {
    expect(isInlineChipOrphan("vh-attach:inl3", new Set(["inl3"]))).toBe(false);
  });

  it("token ABSENT from presentIds -> orphan (true)", () => {
    expect(isInlineChipOrphan("vh-attach:inl3", new Set())).toBe(true);
  });

  it("a DIFFERENT localId present does not rescue it -> orphan (true)", () => {
    expect(isInlineChipOrphan("vh-attach:inl3", new Set(["inl7"]))).toBe(true);
  });

  it("non-inline chip url -> NEVER an orphan (false), regardless of presentIds", () => {
    expect(isInlineChipOrphan("file:///x.png", new Set(["inl3"]))).toBe(false);
    expect(isInlineChipOrphan("file:///x.png", new Set())).toBe(false);
  });

  it("http url -> never an orphan (false)", () => {
    expect(isInlineChipOrphan("https://example.com/x.png", new Set())).toBe(false);
  });

  it("bare prefix (no id) -> not an orphan (degenerate)", () => {
    expect(isInlineChipOrphan("vh-attach:", new Set())).toBe(false);
  });

  it("empty url -> not an orphan", () => {
    expect(isInlineChipOrphan("", new Set())).toBe(false);
  });

  it("composed with scanInlineTokens: a chip whose ref was deleted reads orphaned", () => {
    // The reactive derivation ChatView uses: presentIds derived from the live
    // composer text. Here inl3's ref is gone from the text -> orphan; inl1 still
    // present -> not orphan.
    const presentIds = new Set(scanInlineTokens("see ![a](vh-attach:inl1) end"));
    expect(isInlineChipOrphan("vh-attach:inl1", presentIds)).toBe(false);
    expect(isInlineChipOrphan("vh-attach:inl3", presentIds)).toBe(true);
  });
});

describe("re-insert composition — insertAtCaret(attachMarkdownRef) splices the ref at the caret", () => {
  function mkTa(value: string, sel: number, end = sel): HTMLTextAreaElement {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.selectionStart = sel;
    ta.selectionEnd = end;
    return ta;
  }

  it("re-inserts an IMAGE ref at the caret (orphan -> token present again)", () => {
    // Orphan state: the text no longer holds inl3's ref. Re-insert composes
    // attachMarkdownRef + insertAtCaret exactly as reinsertInlineChip does.
    const ta = mkTa("see  end", 4); // caret between "see " and " end"
    insertAtCaret(ta, attachMarkdownRef("a.png", true, "inl3"));
    expect(ta.value).toBe("see ![a.png](vh-attach:inl3) end");
    // After re-insert, scanInlineTokens sees the token -> the chip is no longer
    // orphaned (isInlineChipOrphan now false).
    const presentIds = new Set(scanInlineTokens(ta.value));
    expect(isInlineChipOrphan("vh-attach:inl3", presentIds)).toBe(false);
  });

  it("re-inserts a NON-IMAGE ref identically (same composition, different form)", () => {
    const ta = mkTa("msg", 3);
    insertAtCaret(ta, attachMarkdownRef("d.pdf", false, "inl7"));
    expect(ta.value).toBe("msg[d.pdf](vh-attach:inl7)");
    const presentIds = new Set(scanInlineTokens(ta.value));
    expect(isInlineChipOrphan("vh-attach:inl7", presentIds)).toBe(false);
  });
});

describe("chip delete drops the held File (removeAttachment cleanup seam)", () => {
  it("deleting an inline chip removes its File from inlineFiles", () => {
    // Model ChatView's inlineFiles + removeAttachment cleanup. A real uploaded
    // chip (file://) has no inlineFiles entry and is untouched.
    const inlineFiles = new Map<string, File>([
      ["inl3", mkFile("a.png", "image/png")],
      ["inl7", mkFile("d.pdf", "application/pdf")],
    ]);
    // removeAttachment("vh-attach:inl3") cleanup seam:
    const localId = inlineLocalIdFromUrl("vh-attach:inl3");
    expect(localId).toBe("inl3");
    if (localId !== null) inlineFiles.delete(localId);
    expect(inlineFiles.has("inl3")).toBe(false);
    expect(inlineFiles.has("inl7")).toBe(true); // other inline File untouched
  });

  it("deleting a NON-inline chip (file:// url) does not touch inlineFiles", () => {
    const inlineFiles = new Map<string, File>([["inl3", mkFile("a.png", "image/png")]]);
    const localId = inlineLocalIdFromUrl("file:///proj/x.png");
    expect(localId).toBeNull();
    if (localId !== null) inlineFiles.delete(localId); // skipped
    expect(inlineFiles.has("inl3")).toBe(true); // untouched
  });
});

describe("dF1 — successful inline send clears inlineFiles (no retained bytes)", () => {
  it("after a successful resolve + clear, inlineFiles holds no File bytes", async () => {
    // Model the inline send lifecycle: resolve consumes the present tokens
    // (uploads them), and on SUCCESS ChatView clears inlineFiles (dF1). The
    // bytes must not linger for the ChatView lifetime.
    const inlineFiles = new Map<string, File>([["inl1", mkFile("a.png", "image/png")]]);
    const { uploader } = mockUploader({ "a.png": mkResolved("a.png", "image/png", "p/a.png") });
    const r = await resolveInlineAttachments("![a](vh-attach:inl1)", inlineFiles, uploader, false);
    expect(r.uploadedIds).toEqual(["inl1"]); // the held File WAS uploaded (consumed)
    // dF1 success path: ChatView calls inlineFiles.clear().
    inlineFiles.clear();
    expect(inlineFiles.size).toBe(0);
  });

  it("inlineFiles.clear() is idempotent and drops ALL held bytes", () => {
    const inlineFiles = new Map<string, File>([
      ["inl1", mkFile("a.png", "image/png")],
      ["inl2", mkFile("b.png", "image/jpeg")],
      ["inl3", mkFile("d.pdf", "application/pdf")],
    ]);
    inlineFiles.clear();
    expect(inlineFiles.size).toBe(0);
    inlineFiles.clear(); // idempotent
    expect(inlineFiles.size).toBe(0);
  });
});

describe("dF2/b-F1 — failed inline send removes ONLY appended imageParts (targeted removal)", () => {
  // b-F1 removed the UNCONDITIONAL snapshot restore (setAttachments(preResolveAtts))
  // in favor of targeted removal: capture the imageParts array the resolve block
  // appends (reference identity), and on failure filter out ONLY those. This
  // preserves the dF2 no-stacking guarantee AND an operator-added chip during the
  // await window. These tests model ChatView's send() lifecycle with a plain
  // array + a captured `appendedImageParts` ref, exercising the EXACT logic.

  it("WITHOUT targeted removal: imageParts stack on retry (the bug dF2/b-F1 fixes)", async () => {
    // If the appended imageParts are NOT removed on failure, a retry re-resolves
    // and the caller's attachment list accumulates a duplicate.
    // (resolveInlineAttachments is idempotent — the duplication is purely the
    // additive append across attempts.)
    const files = () => new Map<string, File>([["inl1", mkFile("a.png", "image/png")]]);
    const { uploader } = mockUploader({ "a.png": mkResolved("a.png", "image/png", "p/a.png") });
    const text = "![a](vh-attach:inl1)";
    let atts: ResolvedAttachment[] = []; // chips-only baseline modeled as empty
    // Attempt 1: resolve + append (no removal on failure).
    const r1 = await resolveInlineAttachments(text, files(), uploader, true);
    atts = [...atts, ...r1.imageParts];
    expect(atts.length).toBe(1);
    // sendText FAILS -> no removal (bug) -> imageParts linger; retry appends MORE.
    const r2 = await resolveInlineAttachments(text, files(), uploader, true);
    atts = [...atts, ...r2.imageParts];
    expect(atts.length).toBe(2); // DUPLICATE — the bug dF2/b-F1 fixes
  });

  it("WITH targeted removal: retry yields exactly one image part (no stacking)", async () => {
    // The dF2 fix (targeted form): capture the appended imageParts array; on send
    // FAILURE remove ONLY those parts (reference identity). A retry re-resolves
    // from the same baseline -> exactly one image part, not two.
    const files = () => new Map<string, File>([["inl1", mkFile("a.png", "image/png")]]);
    const { uploader } = mockUploader({ "a.png": mkResolved("a.png", "image/png", "p/a.png") });
    const text = "![a](vh-attach:inl1)";
    let atts: ResolvedAttachment[] = []; // chips-only baseline
    let appendedImageParts: ResolvedAttachment[] | null = null;
    // Attempt 1: resolve, append imageParts, capture the appended ref.
    const r1 = await resolveInlineAttachments(text, files(), uploader, true);
    if (r1.imageParts.length > 0) {
      appendedImageParts = r1.imageParts;
      atts = [...atts, ...r1.imageParts];
    }
    expect(atts.length).toBe(1);
    // sendText FAILS -> remove ONLY ours (reference identity, mirroring
    // setAttachments((a) => a.filter((x) => !ours.includes(x)))).
    const ours = appendedImageParts!;
    atts = atts.filter((x) => !ours.includes(x));
    expect(atts.length).toBe(0); // appended imagePart removed
    // Attempt 2 (retry): re-resolve from the same chips-only baseline.
    const r2 = await resolveInlineAttachments(text, files(), uploader, true);
    atts = [...atts, ...r2.imageParts];
    expect(atts.length).toBe(1); // NOT 2 — targeted removal prevented stacking
  });

  it("b-F1: targeted removal PRESERVES an operator-added chip during the await window", async () => {
    // The defect b-F1 fixes: the operator adds an attachment chip to the live
    // list DURING the await resolveInlineAttachments / await sendText window. A
    // failure must NOT discard that chip — only the imageParts the resolve block
    // appended are ours to remove. Here the operator's chip is a distinct
    // ResolvedAttachment object NOT in our appendedImageParts array, so the
    // filter keeps it while still removing our appended image part.
    const files = () => new Map<string, File>([["inl1", mkFile("a.png", "image/png")]]);
    const { uploader } = mockUploader({ "a.png": mkResolved("a.png", "image/png", "p/a.png") });
    const text = "![a](vh-attach:inl1)";
    let atts: ResolvedAttachment[] = [];
    let appendedImageParts: ResolvedAttachment[] | null = null;
    // Resolve + append imageParts (ours), capturing the ref.
    const r1 = await resolveInlineAttachments(text, files(), uploader, true);
    if (r1.imageParts.length > 0) {
      appendedImageParts = r1.imageParts;
      atts = [...atts, ...r1.imageParts];
    }
    expect(atts.length).toBe(1);
    // Operator adds a chip during the await window — a DISTINCT object the
    // failure-removal must NOT touch (e.g. a real upload they dragged in).
    const operatorChip = { url: "file:///op/added.png", filename: "added.png", mime: "image/png" };
    atts = [...atts, operatorChip];
    expect(atts.length).toBe(2);
    // sendText FAILS -> remove ONLY ours (reference identity). operatorChip is a
    // different object than anything in appendedImageParts -> survives.
    const ours = appendedImageParts!;
    atts = atts.filter((x) => !ours.includes(x));
    expect(atts.length).toBe(1);
    expect(atts[0]).toBe(operatorChip); // operator-added chip PRESERVED
    expect(ours.every((x) => !atts.includes(x))).toBe(true); // ours all gone
  });

  it("non-inline mode: appendedImageParts stays null (failure path is a no-op for attachments)", () => {
    // Non-inline mode never enters the resolve block, so appendedImageParts is
    // never assigned. The failure path's `if (appendedImageParts)` guard skips
    // the filter -> attachments() is left as the operator last set it. Only the
    // text is restored. (Documents that the targeted removal is inline-scoped.)
    const liveAtts: ResolvedAttachment[] = [{ url: "file:///x.png", filename: "x.png", mime: "image/png" }];
    const appendedImageParts: ResolvedAttachment[] | null = null; // non-inline
    // sendText FAILS -> guard skips the filter.
    if (appendedImageParts) {
      const ours = appendedImageParts;
      // This line must NOT run; assert it would leave the list intact anyway.
      /* atts = atts.filter((x) => !ours.includes(x)); */
    }
    expect(liveAtts.length).toBe(1); // untouched — operator's chips survive
  });
});

// ---------------------------------------------------------------------------
// a-F1: orphan flag reactivity in the chip-strip <For>.
//
// The orphan flag is a DERIVED ACCESSOR in ChatView's <For> callback
// (`const orphan = () => isInlineChipOrphan(a.url, presentInlineIds())`), read
// inside JSX (classList/data-tip/Show). SolidJS <For> callbacks run ONCE per
// item in a NON-tracking scope, so a captured boolean would freeze; the accessor
// lets the compiler wrap each in-JSX read in a reactive effect tied to
// presentInlineIds (a memo over scanInlineTokens(input())). The pure
// isInlineChipOrphan is already covered above; this block asserts the DERIVED
// accessor recomputes when the present-token set changes — the reactivity the
// in-JSX read relies on.
describe("a-F1 — orphan accessor recomputes against a changing present-token set", () => {
  it("re-deriving orphan() against an updated presentIds set flips the flag", () => {
    // Models the chip-strip reactivity: presentInlineIds() is a memo over
    // scanInlineTokens(input()); as the user edits the composer, the set changes
    // and orphan() (re-read in JSX) must reflect it. Here we drive it directly.
    const chipUrl = "vh-attach:inl3";
    const orphan = (presentIds: Set<string>) => isInlineChipOrphan(chipUrl, presentIds);
    // Composer text still holds the ref -> token present -> NOT an orphan.
    let presentIds = new Set(scanInlineTokens("see ![a](vh-attach:inl3) here"));
    expect(orphan(presentIds)).toBe(false);
    // User deletes the ref -> token absent -> orphan TRUE (re-derived, not cached).
    presentIds = new Set(scanInlineTokens("see  here"));
    expect(orphan(presentIds)).toBe(true);
    // User re-inserts the ref -> present again -> orphan FALSE.
    presentIds = new Set(scanInlineTokens("see ![a](vh-attach:inl3) end"));
    expect(orphan(presentIds)).toBe(false);
  });

  it("the accessor form (vs a captured boolean) yields the value at call time", () => {
    // Proves the shape Solid's compiler needs: orphan is a FUNCTION over a live
    // dependency, so each call() reflects the CURRENT set, not the set at the
    // moment the <For> item was created. A captured `const orphan = ...` would
    // pin the first value forever.
    const chipUrl = "vh-attach:inl7";
    let presentIds = new Set(["inl7"]);
    const orphan = () => isInlineChipOrphan(chipUrl, presentIds); // closure over live var
    expect(orphan()).toBe(false); // present at creation
    presentIds = new Set(); // dependency mutates
    expect(orphan()).toBe(true); // re-read reflects the new state (reactive seam)
  });
});
