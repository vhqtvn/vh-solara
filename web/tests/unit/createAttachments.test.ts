// @vitest-environment jsdom
//
// Controller tests for web/src/components/chat/createAttachments.ts
// (the C6 extraction from ChatView). Mirrors the createComposerPaste.test /
// createComposerAutocomplete.test precedent: the factory's deps are injected as
// fakes, the controller is constructed under a Solid `createRoot` owner, and the
// behavior is exercised WITHOUT a component/reactive-render harness.
//
// Regression guards baked in:
//   (1) addFiles inline-mode branch — holds the raw File in inlineFiles, sets a
//       synthetic vh-attach:<localId> chip (file: UNSET), inserts the markdown
//       ref at the caret, mirrors into input(), fires syncCaret (C3) +
//       onInlineInsert (C5).
//   (2) addFiles draft branch — pending:<N> chip with the raw File held.
//   (3) addFiles live eager-upload branch — POST /vh/attach, real url chip.
//   (4) addFiles clears the file-picker input value after a pick (re-pick).
//   (5) removeAttachment — drops a chip AND its held inline File.
//   (6) reinsertInlineChip — splices the markdown ref back at the caret (S5);
//       no-op for a non-inline chip.
//   (7) flushPendingAttachments — uploads draft-queued files once a session
//       exists, replacing pending keys with real urls; leaves already-uploaded
//       chips untouched.
//   (8) presentInlineIds — reactive over input(): tracks which vh-attach tokens
//       are still present (the orphan-truth source for S5).
//   (9) uploadFile — success returns the server-backed Attachment; failure
//       (non-ok / no url) returns null.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import {
  createAttachments,
  type Attachments,
  type AttachmentsDeps,
  type Attachment,
} from "../../src/components/chat/createAttachments";
import { inlineAttachUrl } from "../../src/lib/inlineAttach";

// Solid createMemo + queueMicrotask caret settle is async; flush the microtask
// queue so a presentInlineIds() read after setInput reflects the new text.
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

interface Setup {
  att: Attachments;
  input: () => string;
  setInput: (v: string) => void;
  ta: HTMLTextAreaElement;
  // A plain mock for the file-picker <input>: the factory only reads/sets
  // .value, and jsdom forbids setting a non-empty value on a real
  // <input type=file> (HTML spec), so a real element can't model the
  // before-pick → after-clear transition. The mock can.
  fileInput: { value: string };
  syncCaret: ReturnType<typeof vi.fn>;
  onInlineInsert: ReturnType<typeof vi.fn>;
  // Mutable dep flags so individual tests can flip inline/draft/session per case
  // without rebuilding the controller.
  setInlineActive: (v: boolean) => void;
  setDraft: (v: boolean) => void;
  setSessionId: (v: string) => void;
  dispose: () => void;
}

function setup(opts: { inlineActive?: boolean; draft?: boolean; sessionId?: string } = {}): Setup {
  const [input, setInput] = createSignal("");
  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  const fileInput = { value: "" };
  // Mirror the signal onto the textarea value synchronously, like the real
  // component's value={input()} binding — jsdom clamps selectionStart to
  // value.length, so without this the caret math in insertAtCaret would clamp.
  const wrappedSetInput = (v: string) => {
    setInput(v);
    ta.value = v;
  };
  const [inlineActive, setInlineActive] = createSignal(opts.inlineActive ?? false);
  const [draft, setDraft] = createSignal(opts.draft ?? false);
  const [sessionId, setSessionId] = createSignal(opts.sessionId ?? "");
  const syncCaret = vi.fn();
  const onInlineInsert = vi.fn();
  const deps: AttachmentsDeps = {
    input,
    setInput: wrappedSetInput,
    textarea: () => ta,
    sessionId,
    draft,
    fileInput: () => fileInput as unknown as HTMLInputElement,
    inlineActive,
    syncCaret,
    onInlineInsert,
  };
  let att!: Attachments;
  const dispose = createRoot((d) => {
    att = createAttachments(deps);
    return d;
  });
  return {
    att,
    input,
    setInput: wrappedSetInput,
    ta,
    fileInput,
    syncCaret,
    onInlineInsert,
    setInlineActive,
    setDraft,
    setSessionId,
    dispose,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("createAttachments — addFiles inline-mode branch (S3)", () => {
  it("holds the raw File in inlineFiles + sets a vh-attach:<localId> chip (file UNSET) + inserts the markdown ref", async () => {
    const { att, input, ta, syncCaret, onInlineInsert, setInlineActive } = setup();
    setInlineActive(true);
    const file = new File(["x"], "shot.png", { type: "image/png" });

    att.addFiles([file]);
    await flush();

    // One chip with a synthetic vh-attach: url; file is deliberately UNSET.
    const chips = att.attachments();
    expect(chips).toHaveLength(1);
    expect(chips[0].url.startsWith("vh-attach:")).toBe(true);
    expect(chips[0].file).toBeUndefined();
    expect(chips[0].filename).toBe("shot.png");
    expect(chips[0].mime).toBe("image/png");
    // The held File is keyed by the SAME localId embedded in the chip url.
    const localId = chips[0].url.slice("vh-attach:".length);
    expect(att.inlineFiles.get(localId)).toBe(file);
    // The markdown image ref was inserted at the caret and mirrored into input().
    expect(input()).toContain(`![shot.png](${inlineAttachUrl(localId)})`);
    expect(syncCaret).toHaveBeenCalled();
    expect(onInlineInsert).toHaveBeenCalledTimes(1); // C5 reset seam
  });

  it("non-image inline file inserts a ref WITHOUT the leading ! (link form)", async () => {
    const { att, input, setInlineActive } = setup();
    setInlineActive(true);
    const file = new File(["notes"], "notes.txt", { type: "text/plain" });
    att.addFiles([file]);
    await flush();
    const localId = att.attachments()[0].url.slice("vh-attach:".length);
    expect(input()).toBe(`[notes.txt](${inlineAttachUrl(localId)})`);
  });

  it("clears the file-picker input value after a pick (re-pick of the same file)", async () => {
    const { att, fileInput, setInlineActive } = setup();
    setInlineActive(true);
    fileInput.value = "/tmp/x.txt"; // simulate a picked file held in the input
    att.addFiles([new File(["x"], "a.png", { type: "image/png" })]);
    await flush();
    expect(fileInput.value).toBe("");
  });

  it("no-op on empty/null input (no chip, no inlineFiles entry)", async () => {
    const { att } = setup();
    att.addFiles(null);
    att.addFiles([]);
    await flush();
    expect(att.attachments()).toHaveLength(0);
    expect(att.inlineFiles.size).toBe(0);
  });
});

describe("createAttachments — addFiles draft branch (deferred upload)", () => {
  it("queues the raw File under a pending:<N> key (no upload, no session)", async () => {
    const { att, setDraft } = setup();
    setDraft(true);
    const file = new File(["y"], "drop.txt", { type: "text/plain" });
    att.addFiles([file]);
    await flush();
    const chips = att.attachments();
    expect(chips).toHaveLength(1);
    expect(chips[0].url.startsWith("pending:")).toBe(true);
    expect(chips[0].file).toBe(file); // held locally for send-time upload
    expect(att.inlineFiles.size).toBe(0); // not an inline chip
  });
});

describe("createAttachments — addFiles live eager-upload branch", () => {
  afterEach(() => {
    (globalThis as any).fetch = undefined;
  });

  it("uploads immediately and appends a server-backed chip", async () => {
    const { att, setSessionId } = setup();
    setSessionId("s1");
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ url: "file:///a/x.png", filename: "x.png", mime: "image/png", path: ".vh-solara/x.png" }),
    })) as any;
    const file = new File(["z"], "x.png", { type: "image/png" });
    att.addFiles([file]);
    await flush();
    const chips = att.attachments();
    expect(chips).toHaveLength(1);
    expect(chips[0].url).toBe("file:///a/x.png");
    expect(chips[0].path).toBe(".vh-solara/x.png");
    expect(chips[0].file).toBeUndefined(); // uploaded — raw File dropped
    expect((globalThis as any).fetch).toHaveBeenCalledTimes(1);
    expect(att.inlineFiles.size).toBe(0);
  });

  it("drops a file whose upload fails (uploader returned non-ok) — no chip added", async () => {
    const { att, setSessionId } = setup();
    setSessionId("s1");
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 500 })) as any;
    att.addFiles([new File(["z"], "x.png", { type: "image/png" })]);
    await flush();
    expect(att.attachments()).toHaveLength(0);
  });

  it("no-op when there is no session id (live path, empty session)", async () => {
    const { att } = setup();
    // inlineActive false, draft false, sessionId "" -> live branch hits `if (!id) return`
    att.addFiles([new File(["z"], "x.png", { type: "image/png" })]);
    await flush();
    expect(att.attachments()).toHaveLength(0);
  });
});

describe("createAttachments — removeAttachment (S5 inline File cleanup)", () => {
  it("drops an inline chip AND its held File from inlineFiles", async () => {
    const { att, setInlineActive } = setup();
    setInlineActive(true);
    const file = new File(["x"], "a.png", { type: "image/png" });
    att.addFiles([file]);
    await flush();
    const url = att.attachments()[0].url;
    expect(att.inlineFiles.size).toBe(1);
    att.removeAttachment(url);
    expect(att.attachments()).toHaveLength(0);
    expect(att.inlineFiles.size).toBe(0); // held bytes cleared
  });

  it("drops a non-inline chip without touching inlineFiles (no localId)", async () => {
    const { att } = setup();
    // Simulate an already-uploaded real chip via setAttachments (the raw setter
    // the send() flow also uses for image-parts append).
    const real: Attachment = { url: "file:///a/b.png", filename: "b.png", mime: "image/png" };
    att.setAttachments((a) => [...a, real]);
    expect(att.attachments()).toHaveLength(1);
    att.removeAttachment(real.url);
    expect(att.attachments()).toHaveLength(0);
    expect(att.inlineFiles.size).toBe(0);
  });
});

describe("createAttachments — reinsertInlineChip (S5 orphan re-insert)", () => {
  it("splices an orphaned inline chip's markdown ref back at the caret", async () => {
    const { att, input, setInput, setInlineActive } = setup();
    setInlineActive(true);
    const file = new File(["x"], "orphan.png", { type: "image/png" });
    att.addFiles([file]);
    await flush();
    const chip = att.attachments()[0];
    // Simulate the user DELETING the markdown ref from the text (orphan state).
    setInput("hello");
    expect(input()).toBe("hello");
    // Re-insert at the caret (end of "hello").
    att.reinsertInlineChip(chip);
    await flush();
    const localId = chip.url.slice("vh-attach:".length);
    expect(input()).toBe(`hello![orphan.png](${inlineAttachUrl(localId)})`);
  });

  it("no-op for a non-inline chip (no localId to re-insert)", () => {
    const { att, input } = setup();
    const before = input();
    const real: Attachment = { url: "file:///a/b.png", filename: "b.png", mime: "image/png" };
    att.setAttachments((a) => [...a, real]);
    att.reinsertInlineChip(real);
    expect(input()).toBe(before); // unchanged
  });

  it("fires syncCaret + onInlineInsert after re-inserting", async () => {
    const { att, syncCaret, onInlineInsert, setInlineActive } = setup();
    setInlineActive(true);
    att.addFiles([new File(["x"], "a.png", { type: "image/png" })]);
    await flush();
    syncCaret.mockClear();
    onInlineInsert.mockClear();
    att.reinsertInlineChip(att.attachments()[0]);
    await flush();
    expect(syncCaret).toHaveBeenCalled();
    expect(onInlineInsert).toHaveBeenCalledTimes(1);
  });
});

describe("createAttachments — flushPendingAttachments (draft-lazy upload)", () => {
  afterEach(() => {
    (globalThis as any).fetch = undefined;
  });

  it("uploads pending files once a session exists, replacing pending keys with real urls", async () => {
    const { att, setDraft } = setup();
    setDraft(true);
    const f1 = new File(["1"], "a.txt", { type: "text/plain" });
    const f2 = new File(["2"], "b.txt", { type: "text/plain" });
    att.addFiles([f1, f2]);
    await flush();
    expect(att.attachments().every((a) => a.url.startsWith("pending:"))).toBe(true);

    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ url: "file:///u/a.txt", filename: "a.txt", mime: "text/plain" }),
    })) as any;
    await att.flushPendingAttachments("s1");
    await flush();

    const chips = att.attachments();
    expect(chips).toHaveLength(2);
    expect(chips.every((a) => a.url.startsWith("file://"))).toBe(true);
    expect(chips.every((a) => a.file === undefined)).toBe(true); // raw File dropped
  });

  it("no-op when there are no pending (file-bearing) attachments", async () => {
    const { att } = setup();
    // No attachments at all.
    let fetchCalled = false;
    (globalThis as any).fetch = vi.fn(async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({}) };
    }) as any;
    await att.flushPendingAttachments("s1");
    await flush();
    expect(fetchCalled).toBe(false);
    (globalThis as any).fetch = undefined;
  });
});

describe("createAttachments — presentInlineIds (S5 orphan-truth memo)", () => {
  it("tracks which vh-attach tokens are still present in input()", async () => {
    const { att, setInput } = setup();
    setInput("[a](vh-attach:inl1) [b](vh-attach:inl2)");
    await flush();
    expect(att.presentInlineIds()).toEqual(new Set(["inl1", "inl2"]));
    // Delete one token's ref -> that id leaves the set reactively.
    setInput("[b](vh-attach:inl2)");
    await flush();
    expect(att.presentInlineIds()).toEqual(new Set(["inl2"]));
  });

  it("empty set when no inline tokens are present", async () => {
    const { att, setInput } = setup();
    setInput("plain text, no refs");
    await flush();
    expect(att.presentInlineIds().size).toBe(0);
  });
});

describe("createAttachments — uploadFile", () => {
  afterEach(() => {
    (globalThis as any).fetch = undefined;
  });

  it("POSTs the file and returns the server-backed Attachment (path threaded)", async () => {
    const { att } = setup();
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ url: "file:///a/x.png", filename: "x.png", mime: "image/png", path: ".vh-solara/x.png" }),
    })) as any;
    const r = await att.uploadFile(new File(["z"], "x.png", { type: "image/png" }), "s1");
    expect(r).toEqual({ url: "file:///a/x.png", filename: "x.png", mime: "image/png", path: ".vh-solara/x.png" });
  });

  it("returns null on non-ok response", async () => {
    const { att } = setup();
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 413 })) as any;
    const r = await att.uploadFile(new File(["z"], "x.png", { type: "image/png" }), "s1");
    expect(r).toBeNull();
  });

  it("returns null when the response has no url", async () => {
    const { att } = setup();
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ filename: "x.png" }), // no url
    })) as any;
    const r = await att.uploadFile(new File(["z"], "x.png", { type: "image/png" }), "s1");
    expect(r).toBeNull();
  });

  it("path is undefined when the backend omits it (older backends)", async () => {
    const { att } = setup();
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ url: "file:///a/x.png", filename: "x.png", mime: "image/png" }),
    })) as any;
    const r = await att.uploadFile(new File(["z"], "x.png", { type: "image/png" }), "s1");
    expect(r?.path).toBeUndefined();
  });
});
