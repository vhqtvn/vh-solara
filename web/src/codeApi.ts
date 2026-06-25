// Client for the read-only codebase view. All calls are scoped to the active
// project directory; highlighting + search happen on the daemon, so this stays
// thin (no client-side highlighter or indexer).
import { projectDir } from "./sync";
import { log } from "./lib/log";

const D = () => `dir=${encodeURIComponent(projectDir())}`;

// fetch with a hard timeout — a hung daemon/socket otherwise left the code
// viewer's loading spinners running forever (no createResource ever resolved).
// Logs failures (which the callers otherwise swallow into empty results).
async function timedFetch(url: string, ms = 12000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) log.warn("codeApi", `${url.split("?")[0]} → HTTP ${r.status}`);
    return r;
  } catch (e) {
    log.warn("codeApi", `${url.split("?")[0]} failed`, e);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export interface CodeEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  ignored?: boolean;
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

export async function codeTree(path: string, flatten = true): Promise<CodeEntry[]> {
  try {
    const r = await timedFetch(`/vh/code/tree?${D()}&path=${encodeURIComponent(path)}${flatten ? "" : "&flatten=0"}`);
    if (!r.ok) return [];
    return (await r.json()).entries ?? [];
  } catch {
    return [];
  }
}

export async function codeFile(path: string, opts: { view?: "rendered"; lang?: string } = {}): Promise<CodeFile | null> {
  try {
    const q = (opts.view ? `&view=${opts.view}` : "") + (opts.lang ? `&lang=${encodeURIComponent(opts.lang)}` : "");
    const r = await timedFetch(`/vh/code/file?${D()}&path=${encodeURIComponent(path)}${q}`);
    if (!r.ok) return null;
    return (await r.json()) as CodeFile;
  } catch {
    return null;
  }
}

// Git working-tree status per path: "M" | "A" | "D" | "R" | "?" (new).
export async function codeStatus(): Promise<Record<string, string>> {
  try {
    const r = await timedFetch(`/vh/code/status?${D()}`);
    if (!r.ok) return {};
    return (await r.json()).status ?? {};
  } catch {
    return {};
  }
}

export async function codeLangs(): Promise<string[]> {
  try {
    const r = await timedFetch(`/vh/code/langs`);
    if (!r.ok) return [];
    return (await r.json()).langs ?? [];
  } catch {
    return [];
  }
}

// Resolve a loose/partial path (clicked or selected in chat) to project file(s):
// literal hit, else suffix match. 0 = not found, 1 = open it, >1 = let the user pick.
export async function codeResolve(path: string): Promise<string[]> {
  if (!path.trim()) return [];
  try {
    const r = await timedFetch(`/vh/code/resolve?${D()}&path=${encodeURIComponent(path)}`);
    if (!r.ok) return [];
    return (await r.json()).matches ?? [];
  } catch {
    return [];
  }
}

export const codeRawUrl = (path: string) => `/vh/code/raw?${D()}&path=${encodeURIComponent(path)}`;

export async function codeSearch(q: string, path = ""): Promise<{ hits: CodeHit[]; capped?: boolean }> {
  if (!q.trim()) return { hits: [] };
  try {
    const scope = path ? `&path=${encodeURIComponent(path)}` : "";
    const r = await timedFetch(`/vh/code/search?${D()}&q=${encodeURIComponent(q)}${scope}`);
    if (!r.ok) return { hits: [] };
    return await r.json();
  } catch {
    return { hits: [] };
  }
}

export async function codeStyles(): Promise<{ styles: string[]; default: string }> {
  try {
    const r = await timedFetch(`/vh/code/styles`);
    if (!r.ok) return { styles: [], default: "github-dark" };
    return await r.json();
  } catch {
    return { styles: [], default: "github-dark" };
  }
}
