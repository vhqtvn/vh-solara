// Tool-naming helpers shared by the chat's tool rows (Part.tsx) and the
// Working-pill verb selector (sync/selectors.ts). Kept in a leaf module with no
// store/component imports so both layers can read it without a cycle —
// sync/selectors ← components/Part ← sync barrel would otherwise circle back.
import type { Part } from "../types";

// Friendly tool labels (mirrors OpenChamber's TOOL_METADATA displayName). Falls
// back to a title-cased version of the raw tool name for anything unmapped.
// Used by the tool rows' `.tool-name` (Part.tsx).
const TOOL_LABELS: Record<string, string> = {
  read: "Read File", write: "Write File", edit: "Edit File", multiedit: "Multi-Edit",
  patch: "Apply Patch", apply_patch: "Apply Patch", bash: "Shell", grep: "Search Files",
  glob: "Find Files", list: "List Directory", ls: "List Directory", task: "Agent Task",
  webfetch: "Fetch URL", fetch: "Fetch URL", websearch: "Web Search", codesearch: "Code Search",
  todowrite: "Update Todos", todoread: "Read Todos", skill: "Load Skill", question: "Question", lsp: "LSP",
};
export function toolLabel(tool: string): string {
  const t = (tool || "").toLowerCase();
  return TOOL_LABELS[t] || (tool || "").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || tool;
}

// Present-participle verbs for the Working pill ("Reading src/parser.go · 4s"),
// so the status reads as what the agent is doing right now rather than a noun.
// Unmapped tools fall back to the noun label (toolLabel) rather than a
// mechanically-derived participle, which produces bad English for compound names.
const TOOL_VERBS: Record<string, string> = {
  read: "Reading", todoread: "Reading",
  write: "Writing",
  edit: "Editing", multiedit: "Editing",
  patch: "Applying", apply_patch: "Applying",
  bash: "Running", task: "Running",
  grep: "Searching", websearch: "Searching", codesearch: "Searching",
  glob: "Finding",
  list: "Listing", ls: "Listing",
  webfetch: "Fetching", fetch: "Fetching",
  todowrite: "Updating",
  skill: "Loading",
  question: "Asking",
  lsp: "Querying",
};
export function toolVerb(tool: string): string {
  const t = (tool || "").toLowerCase();
  return TOOL_VERBS[t] || toolLabel(tool);
}

// The slice of a tool part's `state` we read here. Typed locally so this leaf
// stays independent of the component-side ToolState definition in Part.tsx.
interface ToolStateLike {
  input?: Record<string, unknown> | null;
  time?: { start?: number; end?: number } | null;
  status?: string;
}

// The salient input "expression" for a tool — the command for bash, the pattern
// for glob/grep, the path for read/write/edit, the url for webfetch, etc.
// Extracted verbatim from Part.tsx's ToolPart.expr() so the Working pill shows
// the SAME subject as the tool row without duplicating the per-tool argument
// mapping. Returns "" when the tool has no salient single-string argument.
export function toolSubject(part: Part): string {
  const tool = (part.tool as string | undefined) ?? "";
  const st = (part.state || {}) as ToolStateLike;
  const input = (st.input || (part as any).input || {}) as Record<string, any>;
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof input[k] === "string" && input[k]) return input[k] as string;
    return "";
  };
  switch (tool) {
    case "bash":
      return pick("command");
    case "glob":
      return pick("pattern", "query");
    case "grep":
      return pick("pattern", "query", "regex");
    case "read":
    case "write":
    case "edit":
    case "multiedit":
      return pick("filePath", "file", "path");
    case "list":
    case "ls":
      return pick("path", "dir");
    case "webfetch":
    case "fetch":
      return pick("url");
    default:
      return "";
  }
}
