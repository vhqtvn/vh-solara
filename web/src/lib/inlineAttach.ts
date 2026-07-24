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
