// Terminal session management (Settings → Terminals): list live sessions with a
// preview, and kill them. Distinct from the per-pane WebSocket.
export interface TermInfo {
  dir: string;
  clients: number;
  cols: number;
  rows: number;
  idleSec: number;
  preview: string;
}

export async function listTerms(): Promise<TermInfo[]> {
  try {
    const r = await fetch("/vh/term/list");
    return r.ok ? ((await r.json()) as TermInfo[]) : [];
  } catch {
    return [];
  }
}

export async function killTerm(dir: string): Promise<boolean> {
  try {
    const r = await fetch("/vh/term/kill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
