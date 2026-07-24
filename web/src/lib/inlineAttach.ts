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

// --- S4: send-resolve (token scan + path substitute + vision file parts) ----
//
// At send time the inline-mode markdown refs in the composer text are the
// SOURCE OF TRUTH for which attachments still exist: a ref the user deleted is
// gone and its held File MUST NOT be uploaded (lazy upload). These helpers turn
// that contract into data:
//
//   1. scanInlineTokens(text)       -> which vh-attach:<localId> are still present
//   2. resolveInlineAttachments(...) -> upload ONLY those, build id->path, pick
//      the image file parts (vision only)
//   3. substituteInlineTokens(...)   -> splice each token -> real path in text
//
// All three are framework-free. The orchestration (resolveInlineAttachments) is
// async only because it awaits the supplied uploader; pass a mock to unit-test
// the lazy-upload / vision-gate / graceful-fallback behavior without a server.

// A resolved (server-backed) inline attachment: same shape as ChatView's
// Attachment minus the raw `file` (the bytes are gone once uploaded).
// `path` is the project-relative path from attach.go; it MAY be absent on older
// backends / transient responses — callers fall back to `url` in that case.
export interface ResolvedAttachment {
  url: string;
  filename: string;
  mime: string;
  path?: string;
}

// The uploader dependency: given the held File, return the server-backed
// resolved attachment, or null on failure. Injected so resolveInlineAttachments
// is unit-testable with a mock and has no fetch/global coupling.
export type InlineUploader = (file: File) => Promise<ResolvedAttachment | null>;

// Matches a vh-attach:<localId> token and captures the localId. localId chars
// are [A-Za-z0-9_-] (the INLINE_LOCALID_PREFIX "inl" + a monotonic counter, but
// the class is general so any safe localId round-trips). The trailing context
// (e.g. the ")" of a markdown ref) is NOT part of the capture. Global, so it
// finds every occurrence; callers reset lastIndex via String.replace / matchAll.
const INLINE_TOKEN_RE = /vh-attach:([A-Za-z0-9_-]+)/g;

// Pure: return the deduped localIds whose vh-attach:<localId> token is still
// present in `text`, in order of first appearance (stable). Tokens absent from
// the text (the user deleted the markdown ref) are NOT returned, so callers
// never upload them. An empty array means no inline attachments remain.
export function scanInlineTokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(INLINE_TOKEN_RE)) {
    const id = m[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// Pure: replace each vh-attach:<localId> token in `text` with idToPath[localId].
// The surrounding markdown ref structure is preserved (only the token is
// substituted): `![f](vh-attach:inl3)` -> `![f](.vh-solara/.../x.png)`. If a
// token has no entry in idToPath (upload failed / older backend returned no
// path AND no url fallback), the token is LEFT VERBATIM — this is the graceful
// no-silent-drop fallback: the unresolved token stays visible in the outgoing
// text rather than vanishing or crashing.
export function substituteInlineTokens(text: string, idToPath: Record<string, string>): string {
  return text.replace(INLINE_TOKEN_RE, (m, id: string) => idToPath[id] ?? m);
}

// Pure: a synthetic inline-chip url (the chip form set in S3's addFiles inline
// branch). buildParts uses this to EXCLUDE inline chips from the normal
// chip->{type:"file"} path — inline chips are represented in the text, not as
// file parts. Real uploaded attachments have file:// urls and never match.
export function isInlineChipUrl(url: string): boolean {
  return url.startsWith(VH_ATTACH_URL_PREFIX);
}

// Pure selector: given the uploaded inline attachments, return the subset that
// becomes IMAGE file parts. Vision models receive image bytes as a file part
// (in addition to the text markdown ref); non-vision models get text only, so
// `vision=false` always yields []. A non-image upload (e.g. a PDF) is NEVER
// emitted as a file part here regardless of vision — it is referenced via its
// path in the text only. Image = mime startsWith "image/".
export function selectInlineImageParts(
  uploads: ResolvedAttachment[],
  vision: boolean,
): ResolvedAttachment[] {
  if (!vision) return [];
  return uploads.filter((u) => typeof u.mime === "string" && u.mime.startsWith("image/"));
}

// Result of resolving inline attachments at send. `resolvedText` has every
// present token substituted with its real path (absent/unmapped tokens left).
// `imageParts` are the uploaded image attachments to emit as file parts (vision
// only); they carry real file:// urls so buildParts includes them. `uploadedIds`
// / `failedIds` are diagnostics for which held Files were consumed / dropped.
export interface InlineResolveResult {
  resolvedText: string;
  idToPath: Record<string, string>;
  imageParts: ResolvedAttachment[];
  uploadedIds: string[];
  failedIds: string[];
}

// Impure-in-shape (awaits `uploader`) but deterministic under a mock uploader.
// Implements the lazy-upload + substitute + vision-gate contract:
//   - Only localIds PRESENT in `text` are uploaded (scanInlineTokens); a held
//     File whose markdown ref was deleted is never passed to `uploader`.
//   - Each successful upload's path is threaded into idToPath; if the backend
//     returned no `path` (older backend / transient), fall back to `url` so the
//     substitution never crashes and the attachment is still referenced.
//   - A failed upload (uploader returned null) is recorded in failedIds and its
//     token is LEFT in the text (no silent drop, no throw).
//   - `vision` selects image file parts (selectInlineImageParts).
// `files` is the ChatView-local Map<localId, File> (S3); a present token whose
// localId is not in `files` (should not happen in normal flow) is skipped — its
// token is left verbatim by substituteInlineTokens (idToPath has no entry).
export async function resolveInlineAttachments(
  text: string,
  files: Map<string, File>,
  uploader: InlineUploader,
  vision: boolean,
): Promise<InlineResolveResult> {
  const presentIds = scanInlineTokens(text);
  const idToPath: Record<string, string> = {};
  const uploads: ResolvedAttachment[] = [];
  const uploadedIds: string[] = [];
  const failedIds: string[] = [];
  for (const localId of presentIds) {
    const file = files.get(localId);
    if (!file) {
      // Token present in text but no held File: leave the token (no mapping).
      failedIds.push(localId);
      continue;
    }
    const uploaded = await uploader(file);
    if (!uploaded) {
      failedIds.push(localId);
      continue;
    }
    // Graceful path fallback: prefer the project-relative `path`; if the backend
    // returned none, use the file:// url so the ref still resolves to the file.
    idToPath[localId] = uploaded.path || uploaded.url;
    uploads.push(uploaded);
    uploadedIds.push(localId);
  }
  return {
    resolvedText: substituteInlineTokens(text, idToPath),
    idToPath,
    imageParts: selectInlineImageParts(uploads, vision),
    uploadedIds,
    failedIds,
  };
}

// --- S5: orphan indicator + localId extraction -----------------------------
//
// The inline-mode markdown ref in the composer text is the SOURCE OF TRUTH for
// "this attachment exists" (S3/S4). A chip whose token the user deleted from
// the text (while the chip persists) is an ORPHAN: its held File will NOT be
// uploaded at send (lazy upload skips absent tokens) and the chip is shown
// dimmed with a "won't be uploaded / sent" affordance plus a re-insert control
// that splices the markdown ref back at the textarea caret. These pure helpers
// extract localId from a chip url and decide orphan status from the present-
// token set, so the orphan UI is a thin reactive wrapper over
// scanInlineTokens(input()) (S4) + isInlineChipOrphan (here). Framework-free
// so they are unit-testable in jsdom without mounting ChatView.

// Pure: extract the localId from a synthetic inline-chip url, or null if the
// url is not a vh-attach: url (a real uploaded file:// attachment, an http url,
// etc.) or is the bare prefix form with no id. Inverse of inlineAttachUrl.
//   inlineLocalIdFromUrl("vh-attach:inl3") -> "inl3"
//   inlineLocalIdFromUrl("file:///x.png")  -> null   (non-inline, N/A)
//   inlineLocalIdFromUrl("vh-attach:")     -> null   (bare prefix, no id)
export function inlineLocalIdFromUrl(url: string): string | null {
  if (!isInlineChipUrl(url)) return null;
  const localId = url.slice(VH_ATTACH_URL_PREFIX.length);
  return localId.length > 0 ? localId : null;
}

// Pure: is an inline chip ORPHANED? An orphan is a vh-attach:<localId> chip
// whose localId is NOT in `presentIds` — the set of localIds whose markdown ref
// is still present in the composer text (derived reactively in ChatView from
// scanInlineTokens(input())). Non-inline urls (real file:// uploads, http, "")
// are NEVER orphans: they represent attachments that exist independent of the
// composer text. The orphan concept applies ONLY to inline chips.
//   isInlineChipOrphan("vh-attach:inl3", Set(["inl3"])) -> false (present)
//   isInlineChipOrphan("vh-attach:inl3", Set())         -> true  (absent)
//   isInlineChipOrphan("file:///x.png", Set(["inl3"]))  -> false (non-inline)
export function isInlineChipOrphan(chipUrl: string, presentIds: Set<string>): boolean {
  const localId = inlineLocalIdFromUrl(chipUrl);
  if (localId === null) return false; // non-inline / degenerate -> never orphan
  return !presentIds.has(localId);
}
