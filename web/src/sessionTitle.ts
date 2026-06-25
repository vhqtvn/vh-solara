// Session-title suggestion: ask OpenCode's small model to name a session from
// its conversation. Extracted from sync.ts (it's an isolated feature, not part
// of stream/store state). The caller passes the session's projectID so this
// stays free of the sync store.
import { log } from "./lib/log";

function deslugify(s: string): string {
  const t = s.replace(/[-_]+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

export async function suggestTitle(sessionID: string, projectID: string | undefined): Promise<string | null> {
  if (!projectID) {
    log.warn("title", "no projectID for session; cannot generate name", { sessionID });
    return null;
  }
  // Build context from the conversation (the first user message is the task,
  // but include more so multi-turn sessions name from the whole thread).
  let context = "";
  try {
    const r = await fetch(`/oc/session/${encodeURIComponent(sessionID)}/message`);
    if (r.ok) {
      const msgs = (await r.json()) as Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }>;
      const lines: string[] = [];
      for (const m of msgs) {
        for (const p of m.parts || []) {
          if (p.type === "text" && p.text) lines.push(`${m.info?.role || "?"}: ${p.text}`);
        }
      }
      context = lines.join("\n").slice(0, 2000);
    }
  } catch (e) {
    log.warn("title", "context fetch failed", e);
  }
  log.debug("title", "generate-name", { sessionID, projectID, contextLen: context.length });
  const res = await fetch(`/oc/experimental/project/${encodeURIComponent(projectID)}/copy/generate-name`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context }),
  });
  if (!res.ok) {
    log.error("title", "generate-name failed", { status: res.status });
    return null;
  }
  const data = (await res.json().catch(() => null)) as { name?: string } | null;
  const name = data?.name?.trim();
  return name ? deslugify(name) : null;
}
