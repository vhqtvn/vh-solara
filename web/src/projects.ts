// Client-side project list (mirrors OpenCode web: projects = directories the
// user has opened, persisted locally). vh-solara runs as a daemon whose cwd is
// NOT a meaningful project, so NO project is selected by default: the list is
// empty until the user pins one (recents / Add project…). Selecting a project
// re-scopes the daemon via sync.
import { createSignal } from "solid-js";
import { projectDir, switchProject } from "./sync";
import { loadVersioned, saveVersioned } from "./lib/store";
import { log } from "./lib/log";

export interface Project {
  directory: string; // absolute path; never "" (no synthetic default)
  name: string;
}

const LS_PROJECTS = "vh.projects.v1";

function load(): Project[] {
  const saved = loadVersioned<Project[]>(LS_PROJECTS, 1, [], (old) => (Array.isArray(old) ? (old as Project[]) : []));
  // Drop any legacy stored default (directory "") so a pre-default-removal
  // localStorage can't resurrect the synthetic cwd project.
  return saved.filter((p) => p && p.directory);
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
  if (!directory) return; // no synthetic default exists; nothing to remove
  setProjects(projects().filter((p) => p.directory !== directory));
  save();
  // Removing the active project lands the app on the no-project empty state
  // (projectDir "") rather than silently bridging another workspace.
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

// --- Project activity (cross-workspace root/running counts) ---
//
// The switcher dialog annotates each project row with how many LIVE roots a
// workspace has and how many are currently running. The ACTIVE project's counts
// come from the live client store (no round-trip); every other project's come
// from the worker backend:
//   GET /vh/projects         -> [{dir, epoch, seq, roots}]  (live ROOT count per bridged dir)
//   GET /vh/running-sessions -> {count, workspaces:[{dir, count}]}  (dirs with >0 running)
// Both key by the exact project directory, so they merge into the pinned list
// by `dir`. Root counts are ROOT-ONLY (children/archived excluded) on both sides,
// so idle = roots − running is meaningful. The merge + sort below is a PURE
// function (no DOM, no fetch) so it can be unit-tested directly.

export interface ProjectEndpointItem {
  dir: string;
  roots: number;
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
  roots: Map<string, number>; // dir -> LIVE root count (/vh/projects)
  running: Map<string, number>; // dir -> running root count (/vh/running-sessions)
}

// A row the switcher renders: a project enriched with activity + the active
// marker. `active` rides wherever the row lands in the sort.
export interface ProjectActivityRow {
  directory: string;
  name: string;
  running: number; // 0 when not running / unknown
  idle: number; // max(0, roots − running); 0 when roots unknown
  active: boolean; // true for projectDir()
}

// Reduce the two raw endpoint payloads into dir->count lookup maps. Only dirs
// with count > 0 land in `running` (matches the backend, which omits idle dirs).
export function buildActivityMaps(
  projectsEndpoint: ProjectEndpointItem[],
  runningEndpoint: RunningSessionsPayload,
): ActivityMaps {
  const roots = new Map<string, number>();
  for (const p of Array.isArray(projectsEndpoint) ? projectsEndpoint : []) roots.set(p.dir, p.roots);
  const running = new Map<string, number>();
  for (const w of runningEndpoint?.workspaces ?? []) if (w.count > 0) running.set(w.dir, w.count);
  return { roots, running };
}

// Enrich + sort the pinned project list. Sort order: running projects first,
// then case-insensitive name. The active project keeps its marker wherever it
// sorts. The active project's counts come from the LIVE store (activeRunning /
// activeRoots) to avoid a round-trip; other projects use the endpoint maps.
// `idle` is derived defensively as max(0, roots − running) so a transient
// roots < running (data race between the two endpoints) can never render a
// negative idle count.
export function mergeProjectActivity(
  pinned: Project[],
  maps: ActivityMaps,
  activeDir: string,
  activeRunning: number,
  activeRoots: number,
): ProjectActivityRow[] {
  const { roots, running } = maps;
  const rows: ProjectActivityRow[] = pinned.map((p) => {
    const isActive = p.directory === activeDir;
    const run = isActive ? activeRunning : running.get(p.directory) || 0;
    const tot = isActive ? activeRoots : roots.get(p.directory) || 0;
    return {
      directory: p.directory,
      name: p.name,
      active: isActive,
      running: run,
      idle: Math.max(0, tot - run),
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

// Filter project rows by a case-insensitive substring match against the row's
// name OR directory (either matching keeps the row). An empty/whitespace query
// is a no-op that returns the input array unchanged, so an idle dialog never
// rebuilds the list. `query` may be null/undefined (coerced to empty → no-op),
// matching the impl's `(query ?? "").trim().toLowerCase()`. Pure (no DOM, no
// signals) so it can be unit-tested in isolation, mirroring mergeProjectActivity.
// Generic over any row shape that carries { name, directory } so it serves both
// the enriched ProjectActivityRow (pinned) and the plain Project (recents).
export function filterProjectRows<T extends { name: string; directory: string }>(
  rows: T[],
  query: string,
): T[] {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (r) => r.name.toLowerCase().includes(q) || r.directory.toLowerCase().includes(q),
  );
}

// Build a per-project deep-link URL the switcher's "Copy link" button exposes:
// `${base}?dir=<encoded dir>`. `base` is the page's origin+pathname (NO query or
// hash — pass `${location.origin}${location.pathname}`); `dir` is the project
// directory. The `?dir=` switching machinery already round-trips end-to-end
// (sync/url.ts writes it, sync/store.ts reads it), so a per-project link needs
// only this consumer that BUILDS the URL. Pure (no DOM, no signals) so it can be
// unit-tested in isolation, mirroring filterProjectRows/mergeProjectActivity. An
// empty `dir` still yields `${base}?dir=` (a total function); callers gate the
// affordance on a non-empty dir, since the default workspace has no special link.
export function buildProjectLink(base: string, dir: string): string {
  return `${base}?dir=${encodeURIComponent(dir)}`;
}

// Fetch both activity endpoints (coalesced via Promise.all). Never throws: on
// any failure returns empty maps so the dialog still renders with names alone.
//
// cache:'no-store' opts out of the browser HTTP cache: the dialog refreshes
// counts on every open (ProjectSwitcher's open() createEffect calls this on the
// rising edge), so a stale heuristic-cached GET would defeat the refresh — the
// server also emits Cache-Control:no-store on both endpoints, but the client
// flag is a belt-and-suspenders guard against intermediaries that ignore it.
export async function fetchProjectActivity(): Promise<ActivityMaps> {
  try {
    const [pr, rs] = await Promise.all([
      fetch("/vh/projects", { cache: "no-store" }),
      fetch("/vh/running-sessions", { cache: "no-store" }),
    ]);
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
    return { roots: new Map(), running: new Map() };
  }
}

export { projects, projectDir };
