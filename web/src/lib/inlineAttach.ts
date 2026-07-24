// Inline-attachment MODE resolver + vision predicate + user pref (S2).
//
// This module only resolves the EFFECTIVE inline mode and owns the user-facing
// pref that forces inline ON for vision models. It does NOT touch token
// insertion, caret-insert logic, markdown rendering, buildParts, upload timing,
// or orphan UI — those are S3-S5 and are explicitly out of scope here.
//
// Effective inline logic:
//
//   effectiveInline = !modelHasVision || userForcedInline
//
//   - Non-vision model -> inline ON (default).
//   - Vision model     -> inline OFF (the current chip->image-part behavior is
//     preserved), UNLESS the user forces inline ON via the pref.
//
// The pref vh.prefs.inlineAttach.v1 defaults OFF so vision users keep the
// current behavior unless they opt in. It mirrors the vh.prefs.queueMode.v1
// convention exactly (createSignal + loadVersioned/saveVersioned; same
// reactivity and default-handling as web/src/queue.ts's queueMode, and the
// default-false migrate shape from web/src/models.ts's hideBuiltin).
import { createSignal } from "solid-js";
import { loadVersioned, saveVersioned } from "./store";

// Structural input: any object carrying the vision capability flag. Structurally
// compatible with models.ts's ModelRef without importing it, so the predicate
// and resolver below stay framework-free and unit-testable without mounting
// ChatView (and without pulling models.ts's solid-js/sync graph).
export interface VisionCapable {
  vision?: boolean;
}

// Pure predicate: a model supports image input iff its catalog entry carries
// the vision capability flag. In models.ts (line ~290) that flag is populated
// from `cap.attachment || cap.input?.image` on the provider catalog. No side
// effects, no framework imports. Returns false for null/undefined (no model
// resolved) so callers may pass `findModel(...)` directly without a guard.
export function modelHasVision(model: VisionCapable | null | undefined): boolean {
  return !!model?.vision;
}

// Pure resolver for the effective inline-attachment mode. ChatView will consume
// this in S3+ as `effectiveInline(modelHasVision(currentModel), inlineAttachForced())`.
// Kept pure (no signals, no framework imports) so it is unit-testable in
// isolation. The first parameter is the boolean RESULT of the vision check, not
// a model object — pass `modelHasVision(model)` for it.
export function effectiveInline(modelHasVision: boolean, userForcedInline: boolean): boolean {
  return !modelHasVision || userForcedInline;
}

// --- user pref (mirror of vh.prefs.queueMode.v1) ---------------------------
//
// Forces inline attachments ON even for vision models (which otherwise keep the
// current chip->image-part behavior). Default OFF. Local only — it is not part
// of any queue/attachment payload (mirrors how queueMode is a local toggle that
// never enters QueuedMessage).
const LS_INLINE_ATTACH = "vh.prefs.inlineAttach.v1";

// Default-false migrate mirrors web/src/models.ts hideBuiltin: only an explicit
// positive stored value (1 / "1" / true) is treated as ON; everything else
// (0 / "0" / false / "false" / absent / foreign) falls back to OFF.
const [inlineAttachForced, setInlineAttachForcedSig] = createSignal<boolean>(
  loadVersioned<boolean>(LS_INLINE_ATTACH, 1, false, (o) => o === 1 || o === "1" || o === true),
);
export function setInlineAttachForced(on: boolean) {
  setInlineAttachForcedSig(on);
  saveVersioned(LS_INLINE_ATTACH, 1, on);
}
export { inlineAttachForced };

// --- S3: inline-mode markdown ref + caret-insert helpers -------------------
//
// PURE, framework-free helpers used by ChatView's inline-attachment branch
// (S3). They own the markdown-ref string shape and the textarea splice+caret
// math so both are unit-testable in jsdom without mounting ChatView. They do
// NOT touch upload, buildParts, send-resolve, or orphan UI (S4/S5).
//
// Token <-> File <-> text mapping (deliverable #1):
//   localId           = INLINE_LOCALID_PREFIX + <N>  (e.g. "inl3"); <N> comes
//                       from ChatView's shared pendingSeq counter so inline
//                       localIds never collide with pending:N draft keys.
//   held-File lookup  = a ChatView-local Map<string, File> keyed by localId.
//                       Survives until send; NOT cleared by flushPendingAttachments
//                       (inline chips set file: undefined, so that existing path
//                       skips them — S4 adds a separate text-scan resolver).
//   markdown ref      = attachMarkdownRef(filename, isImage, localId), which
//                       embeds inlineAttachUrl(localId) as the link target.
//   chip url          = inlineAttachUrl(localId) = "vh-attach:<localId>", so
//                       removeAttachment (keys on url) still works on the chip.

// The synthetic attachment url scheme for inline-mode attachments. Appears in
// BOTH the chip's Attachment.url AND the markdown ref's link target, so S4 can
// scan the textarea text for vh-attach:<localId> tokens and resolve each to a
// held File. Distinct from the draft-lazy pending:N scheme (no collision).
export const VH_ATTACH_URL_PREFIX = "vh-attach:";

// The localId prefix for inline-mode attachments (e.g. "inl3"). Paired with a
// shared monotonic counter in ChatView (pendingSeq) so inline localIds never
// collide with pending:N draft keys nor with each other.
export const INLINE_LOCALID_PREFIX = "inl";

// Pure: build the synthetic attachment url for an inline localId.
//   inlineAttachUrl("inl3") -> "vh-attach:inl3"
export function inlineAttachUrl(localId: string): string {
  return VH_ATTACH_URL_PREFIX + localId;
}

// Pure: build the markdown reference inserted at the textarea caret for an
// inline-mode attachment. isImage (caller decides via mime.startsWith("image/"))
// selects the form:
//   image     -> ![filename](vh-attach:localId)
//   non-image ->  [filename](vh-attach:localId)   (no leading !)
// The filename is passed through verbatim (no sanitization) so the visible
// label matches what the user picked; the ref is parsed by us at send (S4),
// not rendered as live markdown before then, so injection is not a concern
// here. Sanitization is deferred to a later slice if it ever matters.
export function attachMarkdownRef(filename: string, isImage: boolean, localId: string): string {
  const body = `[${filename}](${inlineAttachUrl(localId)})`;
  return isImage ? "!" + body : body;
}

// Pure DOM mutation: insert `text` into the textarea at the current caret
// (replacing any selection), then advance the caret to JUST AFTER the inserted
// text. Operates only on ta.value / ta.selectionStart / ta.selectionEnd — no
// framework imports, no signals — so it is jsdom-testable.
//
// ChatView calls this on its taRef for inline-mode attach/paste, then mirrors
// taRef.value into its input() signal. SolidJS controls value={input()}; since
// the assigned string is identical to what the helper just wrote, the DOM does
// not reset the selection (assigning the same value is a no-op at the DOM
// level), so the advanced caret persists — the same property the existing
// pasteFromClipboard insert path relies on.
export function insertAtCaret(ta: HTMLTextAreaElement, text: string): void {
  const start = ta.selectionStart ?? 0;
  const end = ta.selectionEnd ?? 0;
  const before = ta.value.slice(0, start);
  const after = ta.value.slice(end);
  ta.value = before + text + after;
  const pos = start + text.length;
  ta.selectionStart = pos;
  ta.selectionEnd = pos;
}
