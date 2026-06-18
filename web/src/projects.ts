// Client-side project list (mirrors OpenCode web: projects = directories the
// user has opened, persisted locally). The default project ("" = OpenCode serve
// cwd) is always present. Selecting a project re-scopes the daemon via sync.
import { createSignal } from "solid-js";
import { projectDir, switchProject } from "./sync";
import { loadVersioned, saveVersioned } from "./lib/store";

export interface Project {
  directory: string; // "" = default project
  name: string;
}

const LS_PROJECTS = "vh.projects.v1";
const DEFAULT: Project = { directory: "", name: "Default project" };

function load(): Project[] {
  const saved = loadVersioned<Project[]>(LS_PROJECTS, 1, [], (old) => (Array.isArray(old) ? (old as Project[]) : []));
  const list = saved.filter((p) => p && p.directory); // drop any stored default
  return [DEFAULT, ...list];
}

const [projects, setProjects] = createSignal<Project[]>(load());

function save() {
  saveVersioned(LS_PROJECTS, 1, projects().filter((p) => p.directory));
}

function basename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function addProject(rawPath: string) {
  const directory = rawPath.trim().replace(/\/+$/, "");
  if (!directory) return;
  if (!projects().some((p) => p.directory === directory)) {
    setProjects([...projects(), { directory, name: basename(directory) }]);
    save();
  }
  switchProject(directory);
}

export function removeProject(directory: string) {
  if (!directory) return; // can't remove the default
  setProjects(projects().filter((p) => p.directory !== directory));
  save();
  if (projectDir() === directory) switchProject("");
}

export function selectProject(directory: string) {
  switchProject(directory);
}

// Recent projects from OpenCode (GET /project → known project directories,
// most-recently-active first), so the switcher can offer a pick list instead of
// only manual paths.
export async function fetchRecentProjects(): Promise<Project[]> {
  try {
    const res = await fetch("/oc/project");
    if (!res.ok) return [];
    const arr = await res.json();
    if (!Array.isArray(arr)) return [];
    // OpenCode can hold several project records for the SAME worktree (e.g. a
    // re-init gives a new project id), so dedupe by directory — keeping the
    // most-recently-active one (first after the desc sort) — to avoid duplicate
    // rows in the recents list.
    const seen = new Set<string>();
    return arr
      .map((p: any) => ({
        directory: (p.worktree || p.directory || "").replace(/\/+$/, ""),
        name: p.name || basename(p.worktree || p.directory || ""),
        updated: p.time?.updated || 0,
      }))
      .filter((p) => p.directory)
      .sort((a, b) => b.updated - a.updated)
      .filter((p) => (seen.has(p.directory) ? false : (seen.add(p.directory), true)))
      .map(({ directory, name }) => ({ directory, name }));
  } catch {
    return [];
  }
}

export { projects, projectDir };
