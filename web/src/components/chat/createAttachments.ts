// Attachment pipeline controller — pending attachments (file parts), inline-mode
// token<->File<->text mapping, and the upload/flush lifecycle.
//
// Extracted from ChatView.tsx (C6) so the attachment concern can be exercised
// in isolation, mirroring the createComposerAutocomplete (C3) /
// createPromptHistory (C5) / createComposerPaste (C4) / createQueueSync (C7)
// precedent: a SolidJS `create...` controller factory (NOT a React-style
// `use...` hook).
//
// The factory is constructed ONCE under the ChatView Solid owner. It takes
// Accessor<T> reactive inputs + explicit setters + DOM ref accessors + a caret-
// sync seam (from C3) and an optional history-reset seam (from C5), registers
// the presentInlineIds memo inside that owner, and returns the attachment
// accessors + the pipeline actions. The attachment-chip JSX, <For>, orphan-
// state accessor reads, CSS, textarea autosize, and all geometry/observer
// ownership stay in ChatView.
//
// What moved here (~215 LOC, previously inlined in ChatView):
//   - the Attachment interface + attachments/uploading signals
//   - uploadFile — POST a raw File into the project's .vh-solara attachments dir
//   - pendingSeq + pendingKey (draft-queued synthetic key) + nextInlineLocalId
//     (inline-mode localId drawn from the SAME counter)
//   - inlineFiles — the Map<localId, File> holding raw inline-mode bytes until
//     send (S3)
//   - presentInlineIds — reactive memo over scanInlineTokens(input()); the source
//     of truth for inline-chip orphan status (S5)
//   - flushPendingAttachments — upload draft-queued files once a session exists
//   - addFiles — the attachment pipeline entry point (inline-mode insert vs
//     draft pending-key vs live eager upload). C4 paste hands harvested files
//     here via its addFiles hook; the hidden <input type=file> onChange calls
//     this directly.
//   - removeAttachment — drop a chip (and its held inline File, if any)
//   - reinsertInlineChip — splice an orphaned inline chip's markdown ref back
//     at the caret (S5)
//
// What stays in ChatView: the attachment-chip JSX rendering (<For> over
// attachments, orphan accessor reads via presentInlineIds), the send() flow's
// OWN orchestration (resolveInlineAttachments + the ownership-snapshot clear +
// image-parts append + failure rollback — those read attachments()/
// setAttachments/inlineFiles RETURNED here), buildParts (the pure
// text+attachments -> parts builder), textarea autosize / composer geometry /
// scroll surface, and CSS.
import { type Accessor, type Setter, createMemo, createSignal } from "solid-js";
import {
  INLINE_LOCALID_PREFIX,
  attachMarkdownRef,
  inlineAttachUrl,
  inlineLocalIdFromUrl,
  insertAtCaret,
  scanInlineTokens,
} from "../../lib/inlineAttach";

// Pending attachments (file parts) to send with the next message.
// `file` is set ONLY for draft-queued attachments (no server session yet): the
// raw File is held locally and uploaded at send time, then `file` is dropped and
// a real `url` takes its place (see flushPendingAttachments). Inline-mode chips
// (vh-attach:<localId>) leave `file` unset — see the inlineFiles comment below.
export interface Attachment {
  url: string;
  filename: string;
  mime: string;
  file?: File;
  path?: string;
}

// Injectable inputs + side effects. ChatView passes its own signals/closures;
// tests pass fakes under createRoot. The textarea + fileInput are Accessors (not
// captured refs) so the factory never holds stale elements across the reused
// component's session switches.
export interface AttachmentsDeps {
  // Current composer text + its setter. The text is the SOURCE OF TRUTH for
  // inline-mode chips (presentInlineIds scans it); setInput mirrors the caret-
  // insert helper's DOM mutation back into the signal.
  input: Accessor<string>;
  setInput: (v: string) => void;
  // The composer textarea (may be undefined before mount / during reuse).
  textarea: Accessor<HTMLTextAreaElement | undefined>;
  // Session id — the live eager-upload branch POSTs to this session. "" / draft
  // routes through the draft pending-key branch instead (no session yet).
  sessionId: Accessor<string>;
  // Draft mode routes picked/pasted files to the pending-key branch (deferred
  // upload) instead of an immediate upload.
  draft: Accessor<boolean>;
  // The hidden file-picker <input>. addFiles clears its value after a pick so
  // the same file can be re-picked.
  fileInput: Accessor<HTMLInputElement | undefined>;
  // Whether inline-attachment mode is currently effective — the addFiles
  // pipeline branches on this (inline insert vs draft pending-key vs live eager
  // upload). Precomputed in ChatView as
  // effectiveInline(modelHasVision(curModel()), inlineAttachForced()) so this
  // module owns NO model/vision/pref concern.
  inlineActive: Accessor<boolean>;
  // Read the textarea caret into the C3 autocomplete controller. Called after an
  // inline-mode markdown-ref insert so token detection tracks the new caret.
  syncCaret: () => void;
  // C5 hook: reset prompt-history walk cursors after an inline-mode insert. The
  // insert bypasses the natural onInput that would reset history. Optional.
  onInlineInsert?: () => void;
}

// Narrow surface returned to ChatView. Accessors + the raw setter are read by
// the chip JSX and the send() flow; the actions are stable for the ChatView
// instance lifetime. `inlineFiles` is exposed as the stable Map reference so
// send()'s resolveInlineAttachments can read it and the success-clear can
// .clear() it.
export interface Attachments {
  // Pending attachments to send with the next message. Read by the chip JSX,
  // send()/sendText(), and the ownership-snapshot guards.
  attachments: Accessor<Attachment[]>;
  // Raw setter — exposed for the send() flow's direct manipulation (image-parts
  // append at resolve time, failure rollback, success clear). The pipeline
  // actions below are the preferred mutation surface; send() needs the raw form
  // for its ownership-snapshot + reference-identity rollback logic, which reads
  // attachments() before an await and conditionally mutates after.
  setAttachments: Setter<Attachment[]>;
  // True while an upload is in flight (chip strip "Uploading…" + attach button
  // disabled).
  uploading: Accessor<boolean>;
  // The attachment pipeline entry point. C4 paste hands harvested files here via
  // its addFiles hook; the hidden <input type=file> onChange calls this directly.
  addFiles: (files: FileList | File[] | null) => void;
  // Drop a chip (and its held inline File, if any).
  removeAttachment: (url: string) => void;
  // Re-insert an orphaned inline chip's markdown ref back at the caret (S5).
  reinsertInlineChip: (a: Attachment) => void;
  // Upload draft-queued (pending) attachments now that a session exists,
  // replacing their synthetic keys with real server urls.
  flushPendingAttachments: (id: string) => Promise<void>;
  // Upload one raw File into the project's .vh-solara attachments dir. Used by
  // the addFiles live-eager path AND the send() flow's resolveInlineAttachments
  // uploader.
  uploadFile: (file: File, id: string) => Promise<Attachment | null>;
  // Held raw inline-mode bytes keyed by localId (S3). Survives until send; read
  // by the send() flow's resolveInlineAttachments + cleared on a successful
  // inline send. Exposed as the stable Map reference (the factory owns it for
  // the ChatView lifetime) so send() can both read and .clear() it.
  inlineFiles: Map<string, File>;
  // Reactive set of inline localIds whose markdown ref is still present in the
  // composer text (S5). Drives orphan status in the chip JSX.
  presentInlineIds: Accessor<Set<string>>;
}

export function createAttachments(deps: AttachmentsDeps): Attachments {
  const [attachments, setAttachments] = createSignal<Attachment[]>([]);
  const [uploading, setUploading] = createSignal(false);

  // Upload one file into the project's .vh-solara attachments dir; returns the
  // server-backed Attachment (with a real url) or null on failure.
  async function uploadFile(file: File, id: string): Promise<Attachment | null> {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/vh/attach?session=${encodeURIComponent(id)}`, {
      method: "POST",
      body: fd,
    });
    if (!res.ok) return null;
    const part = await res.json();
    if (!part?.url) return null;
    // Thread the project-relative attachment path returned by attach.go through
    // into the FE Attachment (and onward into the queue via QueuedAttachment).
    // S1 only carries the field; it is not yet used to build the dispatched
    // part (buildParts). `path` may be absent on older backends → undefined.
    return { url: part.url, filename: part.filename, mime: part.mime, path: part.path };
  }

  // Synthetic key for a draft-queued attachment (no server session yet). Real
  // uploads get a server url; pending ones get this so removeAttachment (which
  // keys on url) still works on the chip before send.
  let pendingSeq = 0;
  const pendingKey = () => `pending:${++pendingSeq}`;

  // --- S3: inline-mode attachment token <-> File <-> text --------------------
  //
  // When inlineActive() is ON (non-vision model, OR vision + user-forced
  // pref), an attached/pasted file is NOT uploaded. Instead we hold the raw
  // File locally keyed by a stable localId, set a synthetic chip whose url is
  // vh-attach:<localId>, and insert a markdown reference at the textarea caret.
  // The markdown ref in the textarea text is the SOURCE OF TRUTH for "this
  // attachment exists"; the chip is a secondary UI affordance for removal.
  //
  // localId shape: INLINE_LOCALID_PREFIX + <N> (e.g. "inl3"), where <N> draws
  // from the SAME pendingSeq counter above so inline localIds never collide
  // with pending:N draft keys. The url is built by the pure inlineAttachUrl().
  //
  // The held File lives in `inlineFiles` (a Map<localId, File>), NOT on
  // Attachment.file. flushPendingAttachments (the existing draft-lazy seam
  // below) filters attachments by `.file` and would double-handle inline chips
  // if they carried it; inline chips set file: undefined, so that existing path
  // skips them untouched. `inlineFiles` survives until send (S4 will scan the
  // textarea text for vh-attach:<localId> tokens and resolve each via this Map).
  const inlineFiles = new Map<string, File>();
  const nextInlineLocalId = () => `${INLINE_LOCALID_PREFIX}${++pendingSeq}`;

  // S5: the set of inline localIds whose markdown ref is STILL PRESENT in the
  // composer text. Reactive over input(): when the user types/deletes, this set
  // recomputes and each inline chip's orphan flag (its token absent from the
  // text) updates. This makes the markdown ref the visible source of truth in
  // the chip strip: a chip whose ref was deleted is shown as an orphan (dimmed,
  // "won't be sent", with a re-insert control). Non-inline chips are unaffected
  // (isInlineChipOrphan returns false for non vh-attach: urls).
  const presentInlineIds = createMemo(() => new Set(scanInlineTokens(deps.input())));

  // Upload any draft-queued (pending) attachments now that a session exists,
  // replacing their synthetic keys with real server urls. Called right after
  // createSession() in send(). A no-op for live sessions, whose attachments
  // upload immediately in addFiles.
  async function flushPendingAttachments(id: string) {
    const pending = attachments().filter((a) => a.file);
    if (pending.length === 0) return;
    setUploading(true);
    try {
      const resolved: Attachment[] = [];
      for (const a of pending) {
        const r = await uploadFile(a.file!, id);
        if (r) resolved.push(r);
      }
      // Keep already-uploaded entries; replace pending ones with resolved urls.
      setAttachments((prev) => [...prev.filter((a) => !a.file), ...resolved]);
    } finally {
      setUploading(false);
    }
  }

  // Queue a file as an attachment for the next message. For a LIVE session the
  // upload happens now (chip shows a server-backed url immediately). For a DRAFT
  // there is no session yet — never create one on paste/pick just to upload:
  // createSession() navigates away from the draft hero and this component-local
  // attachment state is lost on the remount. Instead queue the raw File locally
  // (chip shows from filename) and upload it at send time, once the session
  // exists (see flushPendingAttachments in send()).
  async function addFiles(files: FileList | File[] | null) {
    if (!files || files.length === 0) return;
    // Snapshot the files BEFORE clearing the input: e.currentTarget.files is a
    // LIVE FileList tied to the <input>, so setting fileInputRef.value = ""
    // empties it. Materializing the array first means the upload still sees the
    // picked files. (The paste path passes standalone File objects not tied to
    // the input, so it was never affected.)
    const arr = Array.from(files);
    const fi = deps.fileInput();
    if (fi) fi.value = "";
    // S3: inline mode (non-vision model, OR vision model + user-forced pref)
    // — DO NOT upload. Hold the raw File keyed by localId in `inlineFiles`,
    // set a synthetic chip whose url is vh-attach:<localId>, and insert a
    // markdown ref at the textarea caret. The text ref is the SOURCE OF TRUTH
    // for "this attachment exists"; the chip is a secondary removal affordance.
    // Applies to BOTH draft and live sessions — inline mode is orthogonal to
    // session lifecycle (it is about whether we upload at all). The non-inline
    // path below (draft pending-key / live eager upload) is byte-for-byte
    // unchanged.
    if (deps.inlineActive()) {
      const ta = deps.textarea();
      if (ta) ta.focus();
      for (const file of arr) {
        const localId = nextInlineLocalId();
        inlineFiles.set(localId, file);
        // Chip: url is the synthetic vh-attach:<localId> (so removeAttachment,
        // which keys on url, still works). file: is deliberately UNSET — see
        // the inlineFiles comment above (flushPendingAttachments filters by
        // .file and must skip inline chips).
        setAttachments((a) => [
          ...a,
          { url: inlineAttachUrl(localId), filename: file.name, mime: file.type },
        ]);
        if (ta) {
          insertAtCaret(
            ta,
            attachMarkdownRef(file.name, file.type.startsWith("image/"), localId),
          );
          // Mirror the helper's DOM mutation into the input() signal so
          // SolidJS's controlled value={input()} stays in sync. Assigning the
          // identical string is a DOM no-op, so the caret the helper just
          // advanced persists (no microtask needed, unlike pasteFromClipboard
          // which computes the splice on the signal and must wait for render).
          deps.setInput(ta.value);
          deps.syncCaret();
        }
      }
      deps.onInlineInsert?.();
      return;
    }
    if (deps.draft()) {
      for (const file of arr) {
        setAttachments((a) => [...a, { url: pendingKey(), filename: file.name, mime: file.type, file }]);
      }
      return;
    }
    const id = deps.sessionId();
    if (!id) return;
    setUploading(true);
    try {
      for (const file of arr) {
        const uploaded = await uploadFile(file, id);
        if (uploaded) setAttachments((a) => [...a, uploaded]);
      }
    } finally {
      setUploading(false);
    }
  }

  const removeAttachment = (url: string) => {
    // S5: deleting an inline chip (vh-attach:<localId>) must ALSO drop its held
    // File from inlineFiles — otherwise the bytes linger for the ChatView
    // lifetime even though the chip (and its token) are gone. Non-inline chips
    // (real file:// uploads) have no inlineFiles entry; inlineLocalIdFromUrl
    // returns null and the delete is skipped.
    const localId = inlineLocalIdFromUrl(url);
    if (localId !== null) inlineFiles.delete(localId);
    setAttachments((a) => a.filter((x) => x.url !== url));
  };

  // S5: re-insert an orphaned inline chip's markdown ref back into the composer
  // at the textarea caret, restoring its token so the chip returns to normal
  // (no longer orphaned — the lazy upload will pick it up at send). Mirrors the
  // addFiles inline insert path (insertAtCaret + attachMarkdownRef + mirror into
  // input()). No-op for a non-inline chip (no localId to re-insert).
  const reinsertInlineChip = (a: Attachment) => {
    const localId = inlineLocalIdFromUrl(a.url);
    if (localId === null) return;
    const ta = deps.textarea();
    const ref = attachMarkdownRef(a.filename, a.mime.startsWith("image/"), localId);
    if (ta) {
      ta.focus();
      insertAtCaret(ta, ref);
      // Mirror the helper's DOM mutation into input() so the controlled
      // value={input()} stays in sync (assigning the identical string is a DOM
      // no-op, so the caret the helper advanced persists — same property the
      // addFiles inline insert path relies on).
      deps.setInput(ta.value);
      deps.syncCaret();
    } else {
      // No textarea ref (should not happen in the composer): append to the
      // signal so the token is at least present (caret positioning best-effort).
      deps.setInput(deps.input() + ref);
    }
    deps.onInlineInsert?.();
  };

  return {
    attachments,
    setAttachments,
    uploading,
    addFiles,
    removeAttachment,
    reinsertInlineChip,
    flushPendingAttachments,
    uploadFile,
    inlineFiles,
    presentInlineIds,
  };
}
