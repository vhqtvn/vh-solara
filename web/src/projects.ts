// Client-side project list (mirrors OpenCode web: projects = directories the
// user has opened, persisted locally). The default project ("" = OpenCode serve
// cwd) is always present. Selecting a project re-scopes the daemon via sync.
import { createSignal } from "solid-js";
import { projectDir, switchProject } from "./sync";
import { loadVersioned, saveVersioned } from "./lib/store";
import { log } from "./lib/log";

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
    if (!res.ok) {
      log.warn("projects", `GET /project → HTTP ${res.status}`);
      return [];
    }
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
  } catch (e) {
    log.warn("projects", "GET /project failed", e);
    return [];
  }
}

// --- Project activity (cross-workspace session/running counts) ---
//
// The switcher dialog annotates each project row with how many sessions a
// workspace has and how many are currently running. The ACTIVE project's counts
// come from the live client store (no round-trip); every other project's come
// from the worker backend:
//   GET /vh/projects         -> [{dir, epoch, seq, sessions}]  (one per bridged dir)
//   GET /vh/running-sessions -> {count, workspaces:[{dir, count}]}  (dirs with >0 running)
// Both key by the exact project directory, so they merge into the pinned list
// by `dir`. The merge + sort below is a PURE function (no DOM, no fetch) so it
// can be unit-tested directly.

export interface ProjectEndpointItem {
  dir: string;
  sessions: number;
}
export interface RunningWorkspaceItem {
  dir: string;
  count: number;
}
export interface RunningSessionsPayload {
  count: number;
  workspaces: RunningWorkspaceItem[];
}

export interface ActivityMaps {
  sessions: Map<string, number>; // dir -> total session count (/vh/projects)
  running: Map<string, number>; // dir -> running root count (/vh/running-sessions)
}

// A row the switcher renders: a project enriched with activity + the active
// marker. `active` rides wherever the row lands in the sort.
export interface ProjectActivityRow {
  directory: string;
  name: string;
  sessions: number; // 0 when unknown
  running: number; // 0 when not running / unknown
  active: boolean; // true for projectDir()
}

// Reduce the two raw endpoint payloads into dir->count lookup maps. Only dirs
// with count > 0 land in `running` (matches the backend, which omits idle dirs).
export function buildActivityMaps(
  projectsEndpoint: ProjectEndpointItem[],
  runningEndpoint: RunningSessionsPayload,
): ActivityMaps {
  const sessions = new Map<string, number>();
  for (const p of Array.isArray(projectsEndpoint) ? projectsEndpoint : []) sessions.set(p.dir, p.sessions);
  const running = new Map<string, number>();
  for (const w of runningEndpoint?.workspaces ?? []) if (w.count > 0) running.set(w.dir, w.count);
  return { sessions, running };
}

// Enrich + sort the pinned project list. Sort order: running projects first,
// then case-insensitive name. The active project keeps its marker wherever it
// sorts. The active project's counts come from the LIVE store (activeRunning /
// activeSessions) to avoid a round-trip; other projects use the endpoint maps.
export function mergeProjectActivity(
  pinned: Project[],
  maps: ActivityMaps,
  activeDir: string,
  activeRunning: number,
  activeSessions: number,
): ProjectActivityRow[] {
  const { sessions, running } = maps;
  const rows: ProjectActivityRow[] = pinned.map((p) => {
    const isActive = p.directory === activeDir;
    return {
      directory: p.directory,
      name: p.name,
      active: isActive,
      sessions: isActive ? activeSessions : sessions.get(p.directory) || 0,
      running: isActive ? activeRunning : running.get(p.directory) || 0,
    };
  });
  rows.sort((a, b) => {
    const ar = a.running > 0 ? 1 : 0;
    const br = b.running > 0 ? 1 : 0;
    if (ar !== br) return br - ar; // running first
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }); // then name, case-insensitive
  });
  return rows;
}

// Fetch both activity endpoints (coalesced via Promise.all). Never throws: on
// any failure returns empty maps so the dialog still renders with names alone.
export async function fetchProjectActivity(): Promise<ActivityMaps> {
  try {
    const [pr, rs] = await Promise.all([fetch("/vh/projects"), fetch("/vh/running-sessions")]);
    const projects: unknown = pr.ok ? await pr.json() : [];
    const running: unknown = rs.ok ? await rs.json() : null;
    return buildActivityMaps(
      Array.isArray(projects) ? (projects as ProjectEndpointItem[]) : [],
      running && Array.isArray((running as RunningSessionsPayload).workspaces)
        ? (running as RunningSessionsPayload)
        : { count: 0, workspaces: [] },
    );
  } catch (e) {
    log.warn("projects", "activity fetch failed", e);
    return { sessions: new Map(), running: new Map() };
  }
}

export { projects, projectDir };
