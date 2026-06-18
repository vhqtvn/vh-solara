// Available agents (GET /oc/agent) + the selected primary agent (persisted),
// sent with prompts/shell. Subagents are excluded from the picker.
import { createSignal } from "solid-js";
import { oc } from "./api";
import { applyModel } from "./models";
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
const [selectedAgent, setSel] = createSignal<string>(storedAgent());

export function setSelectedAgent(name: string) {
  setSel(name);
  saveVersioned(LS_AGENT, 1, name);
}

// Select an agent for a session and, if the agent declares a model, switch the
// session's model to it (OpenCode ties a model+variant to each agent). Pass ""
// as sessionID for a draft so the new session inherits the agent's model.
export function selectAgentForSession(sessionID: string, name: string) {
  setSelectedAgent(name);
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

// The agent to actually send with a prompt/shell command: the selected one if
// it still exists in the live list (which already excludes disabled + hidden
// agents), else the first available, else none. Never returns a disabled or
// removed agent name — so we never ask OpenCode to run a non-existent agent.
export function activeAgent(): string {
  const list = agents();
  const sel = selectedAgent();
  if (sel && list.some((a) => a.name === sel)) return sel;
  return list[0]?.name || "";
}

export { agents, selectedAgent };
