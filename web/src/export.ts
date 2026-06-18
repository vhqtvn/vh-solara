// Export a session's transcript as a Markdown file. Fetches the full message
// history (works for any session, not just the open one), formats roles/parts,
// and triggers a download.
import { log } from "./lib/log";

function triggerDownload(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slug(s: string): string {
  return (s || "session").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "session";
}

export async function exportSessionMarkdown(sessionId: string, title: string): Promise<boolean> {
  try {
    const res = await fetch(`/oc/session/${encodeURIComponent(sessionId)}/message`);
    if (!res.ok) return false;
    const msgs = (await res.json()) as Array<{ info?: any; parts?: any[] }>;
    const out: string[] = [`# ${title || sessionId}`, ""];
    for (const m of msgs) {
      const info = m.info || m;
      const role = info.role === "user" ? "User" : info.role === "assistant" ? "Assistant" : info.role || "";
      out.push(`## ${role}`, "");
      for (const p of m.parts || []) {
        if (p.type === "text" && p.text) out.push(p.text, "");
        else if (p.type === "reasoning" && p.text) out.push("> _(thinking)_ " + String(p.text).replace(/\n/g, "\n> "), "");
        else if (p.type === "tool") {
          const st = p.state || {};
          const head = `[tool: ${p.tool}]${st.title ? " " + st.title : ""}`;
          out.push("```", head, ...(st.output ? [String(st.output)] : []), "```", "");
        } else if (p.type === "file") {
          out.push(`📎 ${p.filename || p.mime || "attachment"}`, "");
        }
      }
    }
    triggerDownload(`${slug(title)}.md`, out.join("\n"));
    return true;
  } catch (e) {
    log.error("export", "markdown export failed", e);
    return false;
  }
}
