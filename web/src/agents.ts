// Available agents (GET /oc/agent) + the selected primary agent (persisted),
// sent with prompts/shell. Subagents are excluded from the picker.
import { createEffect, createRoot, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { oc } from "./api";
import { applyAgentModel } from "./models";
import { state, sessionLastAgent, sessionAgentPicks, setSessionAgentPick } from "./sync";
import { loadVersioned, saveVersioned } from "./lib/store";

export interface AgentInfo {
  name: string;
  description?: string;
  mode?: "primary" | "subagent" | "all" | string;
  hidden?: boolean;
  color?: string;
  model?: { providerID: string; modelID: string };
  variant?: string;
}

const LS_AGENT = "vh.agent.v1";
const storedAgent = () => loadVersioned<string>(LS_AGENT, 1, "", (o) => (typeof o === "string" ? o : ""));
const [agents, setAgents] = createSignal<AgentInfo[]>([]);
// `selectedAgent` is the GLOBAL default — the pick for NEW sessions (Settings,
// drafts). It is persisted. Existing sessions NEVER resolve to it implicitly:
// see resolveAgentForSession's evidence ladder.
const [selectedAgent, setSel] = createSignal<string>(storedAgent());

export function setSelectedAgent(name: string) {
  setSel(name);
  saveVersioned(LS_AGENT, 1, name);
}

// The authoritative signal for an EXISTING session's agent is `info.agent` on
// its newest agent-bearing message. Locally that is proxied by an evidence
// ladder (strictest first):
//   1. an explicit per-session pick (the composer dropdown) — PERSISTED per
//      project dir (sync/store.ts sessionAgentPicks) so it survives
//      reload/PWA relaunch (2026-08-16 / 2026-08-26 silent-flip incidents:
//      the pick used to be in-memory only, and after a reload the resolver
//      fell through to the config default while hydration hadn't caught up,
//      sending a supervisor session's prompt as `coordination`);
//   2. the live scan of the loaded message window (sessionLastAgent);
//   3. the server-computed per-session facet state.lastAgents[id] (snapshot-
//      seeded, live-patched by lastAgent.set) — INCLUDING when the window is
//      loaded but holds no agent-stamped message (user messages are
//      sender-stamped with `agent`, so the live scan is fresh after every
//      send; it misses only in the evidence-less window, where a stale-but-
//      real facet beats a fabricated default);
//   4. else: PENDING. An existing session with no evidence must NEVER send
//      under the config/global default (awaitSendAgent waits, then fails
//      loudly). The ONE legitimate exception: a provably-empty session —
//      hydration complete (messagesDelivered) with zero messages ever — which
//      is new-session-like, so the config default applies.

export type AgentResolution =
  | { state: "agent"; agent: string }
  | { state: "pending" }
  | { state: "unavailable"; agent: string };

// A session is PROVABLY empty when its message hydration completed
// (messagesDelivered — snapshot or refresh delivered the real list) AND the
// delivered window holds zero messages. Only then may the config default
// legitimately label it "never ran under an agent". A session with
// messagesDelivered unset is UNRESOLVED, not empty.
export function isProvablyEmptySession(id: string): boolean {
  if (!id) return true; // drafts resolve via selectedAgent
  return state.messagesDelivered[id] === true && (state.messages[id]?.order.length ?? 0) === 0;
}

// Resolve the agent for a session (display AND send — the single shared
// resolver). createSend snapshots it ONCE at tap: a resolved tap sends that
// exact displayed value (never re-resolved), and a pending tap waits for the
// FIRST valid resolution — the same pending→resolved transition this
// resolver's reactivity drives in the Composer's display. Reactive in
// sessionID, the picks store, the message window, lastAgents, the agent
// list, and selectedAgent — the composer follows whichever lands first.
//
// Validation: when the live (usable) agent list is loaded and the
// evidence-backed agent is NOT in it, the outcome is `unavailable` — NOT a
// silent list[0]/config-default substitution (that would stamp the wrong
// agent on the next send). The UI shows an explicit "unavailable — pick an
// agent" state and the send gate refuses until the user picks or the agent
// returns. While the list is empty (not yet loaded) nothing is demoted: an
// `agent` outcome stays `agent` (the list may just be slow), and a pending
// outcome stays pending.
export function resolveAgentForSession(sessionID: string): AgentResolution {
  const list = agents();
  if (!sessionID) {
    // Draft (composing a NEW session): the config-default policy applies —
    // the global default, validated against the live list so a
    // removed/disabled agent never sticks.
    const pick = selectedAgent();
    if (list.length === 0) return pick ? { state: "agent", agent: pick } : { state: "pending" };
    if (pick && list.some((a) => a.name === pick)) return { state: "agent", agent: pick };
    return { state: "agent", agent: list[0].name };
  }
  const pick = sessionAgentPicks[sessionID]?.agent ?? sessionLastAgent(sessionID);
  if (!pick) {
    return isProvablyEmptySession(sessionID)
      ? // Genuinely new session (draft-like): config default is legitimate.
        { state: "agent", agent: selectedAgent() || list[0]?.name || "" }
      : { state: "pending" };
  }
  if (list.length === 0) return { state: "agent", agent: pick };
  if (list.some((a) => a.name === pick)) return { state: "agent", agent: pick };
  return { state: "unavailable", agent: pick };
}

// Back-compat display value: the agent name, or "" while pending (Composer
// renders the explicit pending state via resolveAgentForSession; this helper
// remains for callers that just want a string).
export function agentForSession(sessionID: string): string {
  const r = resolveAgentForSession(sessionID);
  return r.state === "agent" ? r.agent : "";
}

// A draft's displayed agent becomes the new session's FIRST evidence: the
// moment a draft materializes into a live id (createSession resolved), the
// tap-time agent is recorded as that session's explicit pick — so the fresh
// id (whose message window is still empty and whose lastAgents facet hasn't
// landed) resolves immediately instead of pending, and no later code path is
// ever tempted to fill the gap with a default. No-ops on empty inputs.
export function adoptDraftAgent(sessionID: string, agent: string) {
  if (!sessionID || !agent) return;
  setSessionAgentPick(sessionID, agent);
}

// Select an agent for a session and, if the agent declares a model, switch the
// session's model to it (OpenCode ties a model+variant to each agent). Pass ""
// as sessionID for a draft so the new session inherits the agent's model.
//
// CONTRACT: an agent-declared model is a DEFAULT. It must NOT override an
// explicit composer model/variant pick the user made for this session.
// applyAgentModel enforces that — it no-ops once the user has chosen a model for
// the session — so switching agents only changes the model when the user hasn't
// explicitly picked one.
export function selectAgentForSession(sessionID: string, name: string) {
  // Remember the pick for THIS session — persisted (survives reload), pruned
  // on session removal, capped (see sync/store.ts sessionAgentPicks).
  if (sessionID) setSessionAgentPick(sessionID, name);
  // Only a draft pick (sessionID === "") updates the GLOBAL default that new
  // sessions inherit. A pick for an existing session must NOT mutate the global,
  // or every other session whose own resolution is absent would flip to this
  // session's agent.
  if (sessionID === "") setSelectedAgent(name);
  const a = agents().find((x) => x.name === name);
  if (a?.model?.providerID && a.model.modelID) {
    applyAgentModel(sessionID, a.model.providerID, a.model.modelID, a.variant);
  }
}

// Resolve the default agent for NEW sessions with this precedence:
//   1. project/global opencode config `default_agent` (GET /config is already
//      merged project-over-global by opencode),
//   2. vh-solara's own stored pick (localStorage),
//   3. "build", else the first usable agent.
//
// Contract: atomic. `agents()` is mutated exactly once — only after Promise.all
// resolves, never mid-fetch. A rejecting fetch leaves `agents()` untouched, so
// the retry-while-empty loop in `ensureAgentsLoaded` (index.tsx) can rely on a
// thrown loadAgents() meaning "loaded nothing, retry". Do not add a partial
// setAgents before a later await without re-checking that caller.
export async function loadAgents() {
  const [list, config] = await Promise.all([
    oc.get<AgentInfo[]>("/agent"),
    oc.get<any>("/config").catch(() => null),
  ]);
  if (!Array.isArray(list)) return;
  // Match opencode web's composer picker: primary/all agents only, never
  // subagents, and never hidden agents.
  const usable = list.filter((a) => a.mode !== "subagent" && !a.hidden);
  setAgents(usable);
  if (!usable.length) return;

  const has = (name?: string) => !!name && usable.some((a) => a.name === name);
  const configDefault = config?.default_agent as string | undefined;
  const stored = storedAgent();

  // Config-declared default takes precedence over a stale stored pick.
  let resolved = "";
  if (has(configDefault)) resolved = configDefault!;
  else if (has(stored)) resolved = stored;
  else resolved = usable.find((a) => a.name === "build")?.name || usable[0].name;
  setSelectedAgent(resolved);
}

// ---------------------------------------------------------------------------
// Send gate.
// ---------------------------------------------------------------------------

// Bound on how long a send WAITS for agent evidence before aborting. Chosen
// to leave headroom inside the queue drainer's per-dispatch 12s timeout
// (queueDrain.ts DEFAULT_DISPATCH_TIMEOUT_MS): the gate runs BEFORE dispatch
// on the enqueue path, so 10s + dispatch leaves the drainer its full window.
export const AGENT_RESOLVE_TIMEOUT_MS = 10_000;

export type SendAgentOutcome =
  | { ok: true; agent: string }
  | { ok: false; reason: "timeout" | "unavailable" | "hydration-error" };

// Normalize a resolution to a send outcome. THE CHOKE POINT that guarantees
// no code path sends an empty/omitted agent for an existing session: an
// `agent`-state resolution with an empty name is downgraded to a hard
// `unavailable` failure — never `ok: true, agent: ""` (which serializes to
// `agent: undefined` and lets opencode resolve the omitted field to the
// config default server-side — the forbidden omit-path in disguise).
function toOutcome(r: AgentResolution): SendAgentOutcome {
  if (r.state === "agent" && r.agent) return { ok: true, agent: r.agent };
  if (r.state === "agent") return { ok: false, reason: "unavailable" };
  return { ok: false, reason: r.state === "unavailable" ? "unavailable" : "timeout" };
}

// The send-time gate: resolve the agent for a session, WAITING (bounded by
// timeoutMs, default AGENT_RESOLVE_TIMEOUT_MS) for hydration evidence if the
// session is pending — messages landing in the window, a lastAgent.set event,
// or the agent list arriving. NEVER falls back to the config default for an
// existing session with no evidence: on timeout/hydration error/unavailability
// the caller must abort the send loudly (no enqueue, composer text kept).
// Drafts ("") resolve immediately via the config-default policy.
//
// `signal` (optional): an AbortSignal from the caller's lifecycle — aborting
// it rejects the wait with reason "timeout" semantics (caller-aborted); used
// by the queue drainer so an abandoned dispatch doesn't outlive its slot.
export function awaitSendAgent(
  sessionID: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<SendAgentOutcome> {
  const first = resolveAgentForSession(sessionID);
  if (first.state === "agent" || first.state === "unavailable") {
    return Promise.resolve(toOutcome(first));
  }
  // Pending: wait for evidence. A provably-empty session flips the resolver
  // to the config-default branch the moment messagesDelivered lands, so the
  // reactive wait below catches it too.
  const timeoutMs = opts?.timeoutMs ?? AGENT_RESOLVE_TIMEOUT_MS;
  return new Promise<SendAgentOutcome>((resolve) => {
    let settled = false;
    let dispose: (() => void) | undefined;
    const done = (o: SendAgentOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      dispose?.();
      opts?.signal?.removeEventListener("abort", onAbort);
      resolve(o);
    };
    const tryResolve = () => {
      const r = resolveAgentForSession(sessionID);
      if (r.state === "agent" || r.state === "unavailable") done(toOutcome(r));
      // Hydration FAILED for this session: no point waiting out the timer.
      else if (state.messagesError[sessionID]) done({ ok: false, reason: "hydration-error" });
    };
    const timer = setTimeout(() => done({ ok: false, reason: "timeout" }), timeoutMs);
    const onAbort = () => done({ ok: false, reason: "timeout" });
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    // createRoot: createEffect outside a component needs an owner for
    // disposal; the effect re-runs on ANY ladder input change (picks store,
    // message window, lastAgents, delivered/error flags, agent list,
    // selectedAgent) — exactly the hydration signals we wait for. The first
    // run is deferred (microtask), by which point `dispose` is assigned.
    dispose = createRoot((d) => {
      createEffect(() => { tryResolve(); });
      return d;
    });
  });
}

export { agents, selectedAgent };
