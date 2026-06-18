// Model selection, modeled on opencode's own web UI:
//   - models carry named `variants` (param presets, e.g. reasoning effort);
//   - selection is per-session, seeded from the session's last user message,
//     falling back to a persisted global default (so new sessions inherit it);
//   - the chosen model is sent as `model`, the variant as a top-level `variant`.
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { state } from "./sync";
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

// The model OpenCode persists on the session itself (server-side, shared across
// clients/devices) — the authoritative per-session model.
function fromSession(sessionId: string): Selection | undefined {
  const m = state.sessions[sessionId]?.model;
  // session.model uses `id`; message.model uses `modelID` — accept either, and
  // only return a selection when the model id actually resolves (else it would
  // mask the message/default fallbacks with an incomplete selection).
  const modelID = m?.modelID ?? m?.id;
  return m?.providerID && modelID ? { providerID: m.providerID, modelID, variant: m.variant } : undefined;
}

// The model last used in a session, read from its most recent user message.
function fromMessages(sessionId: string): Selection | undefined {
  const sm = state.messages[sessionId];
  if (!sm) return undefined;
  for (let i = sm.order.length - 1; i >= 0; i--) {
    const info: any = sm.byId[sm.order[i]]?.info;
    if (info?.role === "user" && info.model?.providerID) {
      return { providerID: info.model.providerID, modelID: info.model.modelID, variant: info.model.variant };
    }
  }
  return undefined;
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
  return normalizeSelection(sessionSel[sessionId] ?? fromSession(sessionId) ?? fromMessages(sessionId) ?? defaultSel() ?? undefined);
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
}

export function chooseVariant(sessionId: string, variant: string | undefined) {
  const cur = selectionFor(sessionId);
  if (!cur) return;
  const sel: Selection = { providerID: cur.providerID, modelID: cur.modelID, variant };
  setSessionSel(sessionId, sel);
  setDefault(sel);
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
