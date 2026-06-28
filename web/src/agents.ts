// Available agents (GET /oc/agent) + the selected primary agent (persisted),
// sent with prompts/shell. Subagents are excluded from the picker.
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { oc } from "./api";
import { applyModel } from "./models";
import { sessionLastAgent } from "./sync";
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
// drafts). It is persisted. The per-session pick is resolved by agentForSession.
const [selectedAgent, setSel] = createSignal<string>(storedAgent());

// In-memory per-session agent override (a dropdown pick before/after a message is
// sent with it). NOT persisted — OpenCode stamps each message's agent, so on
// reload agentForSession falls back to the session's last-message agent. Mirrors
// models.ts's sessionSel.
const [sessionAgentSel, setSessionAgentSel] = createStore<Record<string, string>>({});

export function setSelectedAgent(name: string) {
  setSel(name);
  saveVersioned(LS_AGENT, 1, name);
}

// The agent shown/used for a session: an explicit pick made for it, else the
// agent on its most recent message, else the global default — validated against
// the live (usable) list so a removed/disabled agent never sticks. Reactive in
// sessionID, so the composer follows the session you switch to.
export function agentForSession(sessionID: string): string {
  const list = agents();
  const pick = sessionAgentSel[sessionID] ?? (sessionID ? sessionLastAgent(sessionID) : undefined) ?? selectedAgent();
  if (pick && list.some((a) => a.name === pick)) return pick;
  return list[0]?.name || "";
}

// Select an agent for a session and, if the agent declares a model, switch the
// session's model to it (OpenCode ties a model+variant to each agent). Pass ""
// as sessionID for a draft so the new session inherits the agent's model.
// ONLY a draft pick (sessionID === "") updates the GLOBAL default that new
// sessions inherit; a pick for an existing session is per-session only, so it
// cannot contaminate other sessions whose own resolution is absent.
export function selectAgentForSession(sessionID: string, name: string) {
  setSessionAgentSel(sessionID, name); // remember the pick for THIS session
  // Only a draft pick (sessionID === "") updates the GLOBAL default that new
  // sessions inherit. A pick for an existing session must NOT mutate the global,
  // or every other session whose own resolution is absent falls back to it and
  // silently flips to this session's agent.
  if (sessionID === "") setSelectedAgent(name);
  const a = agents().find((x) => x.name === name);
  if (a?.model?.providerID && a.model.modelID) {
    applyModel(sessionID, a.model.providerID, a.model.modelID, a.variant);
  }
}

// Resolve the default agent for NEW sessions with this precedence:
//   1. project/global opencode config `default_agent` (GET /config is already
//      merged project-over-global by opencode),
//   2. vh-solara's own stored pick (localStorage),
//   3. "build", else the first usable agent.
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

// The agent to actually send with a prompt/shell command for a session. Resolves
// per-session (override → last-message agent → global default), validated against
// the live list — so we never ask OpenCode to run a removed/disabled agent. Pass
// "" for a draft (uses the global default).
export function activeAgent(sessionID = ""): string {
  return agentForSession(sessionID);
}

export { agents, selectedAgent };
