// Client for the read-only codebase view. All calls are scoped to the active
// project directory; highlighting + search happen on the daemon, so this stays
// thin (no client-side highlighter or indexer).
import { projectDir } from "./sync";

const D = () => `dir=${encodeURIComponent(projectDir())}`;

export interface CodeEntry {
  name: string;
  path: string;
  type: "dir" | "file";
}

export interface CodeFile {
  kind: "text" | "markdown" | "image" | "binary" | "toolarge";
  path: string;
  html?: string;
  lang?: string;
  lines?: number;
  size?: number;
  highlighted?: boolean;
  isMarkdown?: boolean;
}

export interface CodeHit {
  path: string;
  line: number;
  text: string;
}

export async function codeTree(path: string): Promise<CodeEntry[]> {
  try {
    const r = await fetch(`/vh/code/tree?${D()}&path=${encodeURIComponent(path)}`);
    if (!r.ok) return [];
    return (await r.json()).entries ?? [];
  } catch {
    return [];
  }
}

export async function codeFile(path: string, view?: "rendered"): Promise<CodeFile | null> {
  try {
    const q = view ? `&view=${view}` : "";
    const r = await fetch(`/vh/code/file?${D()}&path=${encodeURIComponent(path)}${q}`);
    if (!r.ok) return null;
    return (await r.json()) as CodeFile;
  } catch {
    return null;
  }
}

export const codeRawUrl = (path: string) => `/vh/code/raw?${D()}&path=${encodeURIComponent(path)}`;

export async function codeSearch(q: string): Promise<{ hits: CodeHit[]; capped?: boolean }> {
  if (!q.trim()) return { hits: [] };
  try {
    const r = await fetch(`/vh/code/search?${D()}&q=${encodeURIComponent(q)}`);
    if (!r.ok) return { hits: [] };
    return await r.json();
  } catch {
    return { hits: [] };
  }
}

export async function codeStyles(): Promise<{ styles: string[]; default: string }> {
  try {
    const r = await fetch(`/vh/code/styles`);
    if (!r.ok) return { styles: [], default: "github-dark" };
    return await r.json();
  } catch {
    return { styles: [], default: "github-dark" };
  }
}
