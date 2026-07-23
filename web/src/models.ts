// Model selection, modeled on opencode's own web UI:
//   - models carry named `variants` (param presets, e.g. reasoning effort);
//   - selection is per-session, seeded from the session's last user message,
//     falling back to a persisted global default (so new sessions inherit it);
//   - the chosen model is sent as `model`, the variant as a top-level `variant`.
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { inlineSessionModel, lastUserMessageModel, sessionModel } from "./sync";
import { loadVersioned, saveVersioned } from "./lib/store";

export interface ModelRef {
  providerID: string;
  modelID: string;
  provider: string; // provider display name
  name: string; // model display name
  label: string;
  variants: string[];
  // Capability/cost metadata for picker badges (from /provider; may be absent).
  reasoning?: boolean;
  vision?: boolean;
  free?: boolean;
  status?: string; // alpha | beta | deprecated | active
  contextK?: number;
  source?: string; // env | config | custom | api ("api" = OpenCode builtin)
}

export interface Selection {
  providerID: string;
  modelID: string;
  variant?: string;
}

const LS_DEFAULT = "vh.model.default.v1";
const LS_RECENT = "vh.model.recent.v1";
const LS_HIDE_BUILTIN = "vh.model.hideBuiltin.v1";
const RECENT_MAX = 6;

// When enabled, OpenCode's builtin (source "api") models are hidden from the
// picker — useful when you only use your own configured providers.
const [hideBuiltin, setHideBuiltinSig] = createSignal<boolean>(
  loadVersioned<boolean>(LS_HIDE_BUILTIN, 1, false, (o) => o === 1 || o === "1" || o === true),
);
export function setHideBuiltin(on: boolean) {
  setHideBuiltinSig(on);
  saveVersioned(LS_HIDE_BUILTIN, 1, on);
}
export { hideBuiltin };

// Models offered in the picker: the full connected list, minus builtins when the
// user has hidden them. findModel/selection still use the full list, so an
// already-selected builtin model keeps working.
export function pickerModels(): ModelRef[] {
  return hideBuiltin() ? models().filter((m) => m.source !== "api") : models();
}

// Versioned load with a passthrough migration for legacy (unversioned) JSON.
function loadJSON<T>(key: string, fallback: T): T {
  return loadVersioned<T>(key, 1, fallback, (old) => (old == null ? fallback : (old as T)));
}

const [models, setModels] = createSignal<ModelRef[]>([]);
const [defaultSel, setDefaultSig] = createSignal<Selection | null>(loadJSON<Selection | null>(LS_DEFAULT, null));
// In-memory only (NOT persisted): an explicit dropdown pick for a session before
// a message is sent with it. OpenCode is the source of truth for a session's
// model — it persists session.model and stamps each message — so this just
// bridges the moment between picking and sending; on reload selectionFor falls
// back to the server-persisted model. (Previously this was a localStorage map,
// vh.model.sessions.v1, which duplicated server state; opencode web/openchamber
// don't keep one either.)
const [sessionSel, setSessionSel] = createStore<Record<string, Selection>>({});
// Tracks sessions ("" = draft) for which the user has made an explicit composer
// model/variant pick. An agent's declared model is a DEFAULT — it must never
// override such an explicit pick. In-memory only (NOT persisted): provenance
// does not survive reload; on reload the server-persisted session model wins.
const explicitModelPicks = new Set<string>();
const [recentKeys, setRecentKeys] = createSignal<string[]>(loadJSON<string[]>(LS_RECENT, []));

const keyOf = (providerID: string, modelID: string) => providerID + "/" + modelID;

function pushRecent(providerID: string, modelID: string) {
  const k = keyOf(providerID, modelID);
  const next = [k, ...recentKeys().filter((x) => x !== k)].slice(0, RECENT_MAX);
  setRecentKeys(next);
  saveVersioned(LS_RECENT, 1, next);
}

// Recently used models, most-recent first (resolved against the loaded list).
export function recentModels(): ModelRef[] {
  return recentKeys()
    .map((k) => {
      const [p, mid] = k.split("/");
      return findModel(p, mid);
    })
    .filter((m): m is ModelRef => !!m);
}

function setDefault(sel: Selection) {
  setDefaultSig(sel);
  saveVersioned(LS_DEFAULT, 1, sel);
}

export function findModel(providerID: string, modelID: string): ModelRef | undefined {
  return models().find((m) => m.providerID === providerID && m.modelID === modelID);
}

// Some sources (agent config, persisted session model) encode the variant into
// the model id as "modelID:variant". Left as-is it fails the catalog lookup, so
// the model reads as a raw "model:variant" string and the variant dropdown
// (driven by the catalog entry's variants) never appears. Split it back into a
// proper {modelID, variant} when the base model exists and offers that variant.
function normalizeSelection(sel: Selection | undefined): Selection | null {
  if (!sel) return null;
  if (findModel(sel.providerID, sel.modelID)) return sel; // already a catalog id
  const i = sel.modelID.lastIndexOf(":");
  if (i > 0) {
    const base = sel.modelID.slice(0, i);
    const v = sel.modelID.slice(i + 1);
    const m = findModel(sel.providerID, base);
    if (m && (m.variants.includes(v) || v === "default")) {
      return { providerID: sel.providerID, modelID: base, variant: sel.variant ?? (v === "default" ? undefined : v) };
    }
  }
  return sel;
}

// Effective selection for a session: a just-made (unsent) pick, else the
// server-persisted session model, else its last-used message model, else the
// global default.
export function selectionFor(sessionId: string): Selection | null {
  return normalizeSelection(
    sessionSel[sessionId] ?? sessionModel(sessionId) ?? lastUserMessageModel(sessionId) ?? defaultSel() ?? undefined,
  );
}

export function chooseModel(sessionId: string, providerID: string, modelID: string) {
  const cur = selectionFor(sessionId);
  const m = findModel(providerID, modelID);
  // Keep the variant only if the new model also offers it.
  const variant = cur?.variant && m?.variants.includes(cur.variant) ? cur.variant : undefined;
  const sel: Selection = { providerID, modelID, variant };
  setSessionSel(sessionId, sel);
  setDefault(sel);
  pushRecent(providerID, modelID);
  // USER gesture: this session now has an explicit model pick that an
  // agent-select must not override.
  explicitModelPicks.add(sessionId);
}

export function chooseVariant(sessionId: string, variant: string | undefined) {
  const cur = selectionFor(sessionId);
  if (!cur) return;
  const sel: Selection = { providerID: cur.providerID, modelID: cur.modelID, variant };
  setSessionSel(sessionId, sel);
  setDefault(sel);
  // USER gesture: mark the session explicit (same as chooseModel).
  explicitModelPicks.add(sessionId);
}

// Apply a model + variant to a session, or — when there's no session yet (a
// draft, sessionID "") — to the global default so the new session inherits it.
// Used to make the model follow the selected agent's configured model.
export function applyModel(sessionID: string, providerID: string, modelID: string, variant?: string) {
  if (sessionID) {
    chooseModel(sessionID, providerID, modelID);
    chooseVariant(sessionID, variant);
    return;
  }
  const m = findModel(providerID, modelID);
  const v = variant && m?.variants.includes(variant) ? variant : undefined;
  setDefault({ providerID, modelID, variant: v });
  pushRecent(providerID, modelID);
}

// Apply an AGENT-declared model to a session as a DEFAULT: it takes effect only
// when the user has NOT made an explicit composer pick for that session. Once
// the user picks a model/variant (chooseModel/chooseVariant, which marks the
// session explicit), selecting an agent must not silently swap their model.
//
// This is a DEFAULT-tier write — it deliberately does NOT route through
// chooseModel/chooseVariant, because those mark the session explicit and would
// make every later agent-select sticky, breaking the legitimate "switching
// agents brings each agent's own model" default.
//
// For a real session it writes a DEFAULT-tier session selection; for a draft
// (sessionID "") it writes the global default so the new session inherits the
// agent's model. It never touches agent state (that stays in agents.ts).
export function applyAgentModel(sessionID: string, providerID: string, modelID: string, variant?: string) {
  if (explicitModelPicks.has(sessionID)) return; // explicit user pick wins
  // A real session whose model is ALREADY established on the server (after ≥1
  // send — OpenCode persists session.model and stamps each message) is treated
  // as implicit intent: switching agents must NOT silently flip its model.
  // explicitModelPicks is in-memory only and is wiped on reload, so without this
  // a reload followed by an agent switch would let the new agent's declared
  // model clobber the server-persisted pick (the original bug re-emerging).
  //
  // SEMANTIC BROADENING (intentional): this makes a session's established model
  // STICKY across agent switches for ALL live sessions, not only ones with an
  // explicit composer pick. After a session has sent ≥1 message with model X
  // (whether X was an explicit pick or agent-inherited), switching agents will
  // NOT bring the new agent's declared model — X sticks until the user
  // explicitly picks another. Switching agents is about persona/instructions,
  // not silently flipping the model; a user who wants the new agent's model can
  // explicitly pick it.
  //
  // The DRAFT branch below (sessionID === "") is unchanged: a draft has no
  // server session, so inlineSessionModel("")/lastUserMessageModel("") are
  // undefined and the agent model still applies as the default. Likewise a
  // brand-new live session that is not yet in the sync store (no send, no
  // server snapshot) resolves these to undefined, so selecting its first agent
  // still applies the agent's model.
  //
  // PROVENANCE SCOPE (refine): the guard keys on the INLINE server session
  // model (inlineSessionModel) OR the last loaded user-message model
  // (lastUserMessageModel) — NOT the hoisted project default. selectionFor()
  // still resolves DISPLAY/effective selection through sessionModel() (which
  // falls back to projectConstants.model), but this WRITE guard must not:
  // projectConstants.model is a snapshot-compression/display value the backend
  // hoists from active captured sessions (pkg/state/projection.go) and strips
  // from projected rows under hoist=1 — it is NOT per-session user intent. The
  // production tree stream always sends hoist=1, so many projected rows resolve
  // their model ONLY through that fallback; keying the guard on it would wrongly
  // treat such rows as "established" and make them sticky across agent switches.
  // inlineSessionModel reads the session record ONLY (no projectConstants
  // fallback), so a session that merely inherited the project-common model
  // still follows an agent switch.
  if (sessionID && (inlineSessionModel(sessionID) ?? lastUserMessageModel(sessionID))) {
    return;
  }
  if (sessionID) {
    // Real session: a DEFAULT-tier session selection (mirrors the net effect of
    // chooseModel + chooseVariant for the agent's model without going explicit).
    setSessionSel(sessionID, { providerID, modelID, variant });
    pushRecent(providerID, modelID);
    return;
  }
  // Draft (sessionID ""): write the global default so the new session inherits
  // the agent's model — mirrors the draft branch of applyModel above.
  const m = findModel(providerID, modelID);
  const v = variant && m?.variants.includes(variant) ? variant : undefined;
  setDefault({ providerID, modelID, variant: v });
  pushRecent(providerID, modelID);
}

// Carry a session's model selection AND its explicit-pick intent from one id to
// another — used when a draft (props.sessionId "") is materialized into a real
// server session on first send, so an explicit composer pick made under the
// draft key is not lost when captureConfig reads the live id. No-op when the ids
// match (e.g. a non-draft send where props.sessionId is already the live id).
//
// The source (draft-key) selection is deleted: a fresh draft must start clean
// so the draft effect can re-apply an agent's default model rather than inherit
// the stale pick.
export function migrateModelPick(fromID: string, toID: string) {
  if (fromID === toID) return;
  const from = sessionSel[fromID];
  if (from) {
    setSessionSel(
      produce((s: Record<string, Selection>) => {
        s[toID] = from;
        delete s[fromID];
      }),
    );
  }
  if (explicitModelPicks.has(fromID)) {
    explicitModelPicks.add(toID);
    explicitModelPicks.delete(fromID);
  }
}

export async function loadModels() {
  try {
    const res = await fetch("/oc/provider");
    const data = await res.json();
    const connected: Set<string> = new Set(data.connected || []);
    const all: ModelRef[] = [];
    const connectedList: ModelRef[] = [];
    for (const p of data.all || []) {
      for (const [mid, m] of Object.entries<any>(p.models || {})) {
        if (m?.status === "deprecated") continue; // opencode web hides deprecated
        const cap = m?.capabilities || {};
        const cost = m?.cost || {};
        const ref: ModelRef = {
          providerID: p.id,
          modelID: mid,
          provider: p.name || p.id,
          name: m?.name || mid,
          label: `${p.name || p.id} / ${m?.name || mid}`,
          variants: Object.keys(m?.variants || {}),
          reasoning: !!cap.reasoning,
          vision: !!(cap.attachment || cap.input?.image),
          free: cost.input === 0 && cost.output === 0,
          status: m?.status,
          contextK: m?.limit?.context ? Math.round(m.limit.context / 1000) : undefined,
          source: p.source,
        };
        all.push(ref);
        if (connected.has(p.id)) connectedList.push(ref);
      }
    }
    // Prefer connected (authenticated) providers — but never end up with an empty
    // picker if `connected` is missing/misaligned: fall back to all providers so
    // new sessions still have a model to send.
    const list = connectedList.length > 0 ? connectedList : all;
    list.sort((a, b) => a.label.localeCompare(b.label));
    setModels(list);

    if (list.length) {
      const cur = defaultSel();
      const valid = cur && list.some((m) => m.providerID === cur.providerID && m.modelID === cur.modelID);
      if (!valid) {
        const def = data.default || {};
        const provID = Object.keys(def)[0];
        const seed =
          (provID && list.find((m) => m.providerID === provID && m.modelID === def[provID])) || list[0];
        setDefault({ providerID: seed.providerID, modelID: seed.modelID });
      }
    }
  } catch {
    /* leave models empty; prompts fall back to the opencode default */
  }
}

export { models, defaultSel };
