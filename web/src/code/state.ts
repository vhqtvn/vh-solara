// State for the code viewer, used INSIDE the code frame (the standalone page
// rendered in an iframe). The open file/line + the open-tab strip live here; the
// chat (in the parent frame) drives them across the frame boundary via
// postMessage — see codeFrame.ts.
import { createSignal } from "solid-js";
import { codeResolve } from "./api";

// Open editor tabs (VS Code style, but read-only): the paths of files the user
// has opened, in order. codeOpenPath is the active one.
export const [codeTabs, setCodeTabs] = createSignal<string[]>([]);
export const [codeOpenPath, setCodeOpenPath] = createSignal("");
export const [codeOpenLine, setCodeOpenLine] = createSignal<number | undefined>(undefined);

// When a loose path resolves to several files, the viewer shows this picker so
// the user can choose which one to open.
export const [resolvePicker, setResolvePicker] = createSignal<{ matches: string[]; line?: number } | null>(null);

// Actually open a (project-relative) path: add a tab + make it active.
export function openResolved(path: string, line?: number) {
  if (!path) return;
  addCodeTab(path);
  setCodeOpenLine(line);
  setCodeOpenPath(path);
}

// Add a path to the tab strip (no-op if already open).
export function addCodeTab(path: string) {
  if (!path) return;
  setCodeTabs((t) => (t.includes(path) ? t : [...t, path]));
}

// Close a tab; if it was active, activate its neighbour (or clear).
export function closeCodeTab(path: string) {
  const tabs = codeTabs();
  const idx = tabs.indexOf(path);
  if (idx < 0) return;
  const next = tabs.filter((p) => p !== path);
  setCodeTabs(next);
  if (codeOpenPath() === path) {
    setCodeOpenLine(undefined);
    setCodeOpenPath(next[Math.min(idx, next.length - 1)] || "");
  }
}

// Open a file in the (in-frame) viewer, optionally at a line. Accepts a raw
// reference like "src/parser.go:42" (strips a leading "./" and a trailing
// :line[:col]). Resolves loose/partial paths against the project: a unique hit
// opens directly, several show a picker, none opens the literal path (the viewer
// surfaces its own not-found). Called by the frame's UI + its postMessage handler.
export async function openFileLocal(pathOrRef: string, line?: number) {
  let path = pathOrRef.trim().replace(/^\.\//, "");
  if (line === undefined) {
    const m = path.match(/^(.+?):(\d+)(?::\d+)?$/);
    if (m) {
      path = m[1];
      line = Number(m[2]);
    }
  }
  setResolvePicker(null);
  const matches = await codeResolve(path);
  if (matches.length > 1) {
    setResolvePicker({ matches, line });
    return;
  }
  openResolved(matches[0] ?? path, line);
}
