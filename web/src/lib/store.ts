// Versioned localStorage. Every persisted value is wrapped as {v, data} so the
// schema can evolve: on read, a value at an older version is run through an
// optional migrate() (which also handles legacy unversioned values, passed with
// fromVersion 0), and a bad/foreign payload falls back cleanly. Writes are
// best-effort (private-mode / quota errors are swallowed).
import { createSignal, type Accessor } from "solid-js";

interface Envelope<T> {
  v: number;
  data: T;
}

export function loadVersioned<T>(
  key: string,
  version: number,
  fallback: T,
  migrate?: (old: unknown, fromVersion: number) => T,
): T {
  const raw = (() => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  })();
  if (raw == null) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON — a legacy plain-string value (e.g. an old theme id). Migrate it.
    return migrate ? migrate(raw, 0) : fallback;
  }
  if (parsed && typeof parsed === "object" && "v" in parsed && "data" in parsed) {
    const env = parsed as Envelope<T>;
    if (env.v === version) return env.data;
    return migrate ? migrate(env.data, env.v) : fallback; // newer/older schema
  }
  // Legacy unversioned JSON value (fromVersion 0): migrate it forward or drop it.
  return migrate ? migrate(parsed, 0) : fallback;
}

export function saveVersioned<T>(key: string, version: number, data: T): void {
  try {
    localStorage.setItem(key, JSON.stringify({ v: version, data } satisfies Envelope<T>));
  } catch {
    /* private mode / quota — ignore */
  }
}

// A Solid signal backed by versioned localStorage: hydrated from storage on
// init, and the returned setter persists on every write. Collapses the
// "createSignal(loadVersioned(...)) + a setter that calls saveVersioned" pattern
// that was hand-written for every preference. The setter takes a value (prefs
// don't use the updater form). Wrap it when a setter also has a side effect
// (e.g. apply the value to the DOM).
export function persistedSignal<T>(
  key: string,
  version: number,
  fallback: T,
  migrate?: (old: unknown, fromVersion: number) => T,
): [Accessor<T>, (value: T) => void] {
  const [get, set] = createSignal<T>(loadVersioned(key, version, fallback, migrate));
  const setSaved = (value: T) => {
    set(() => value);
    saveVersioned(key, version, value);
  };
  return [get, setSaved];
}

// Coercion for a persisted boolean from a legacy/foreign stored value, with a
// default for anything unrecognized. Unifies the several ad-hoc variants.
export function boolMigrate(def: boolean) {
  return (o: unknown): boolean => {
    if (o === true || o === 1 || o === "1" || o === "true") return true;
    if (o === false || o === 0 || o === "0" || o === "false") return false;
    return def;
  };
}
