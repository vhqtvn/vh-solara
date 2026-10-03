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

// Optional persistedSignal behaviors. Strictly additive: every field is
// optional and call sites that pass no options behave exactly as before.
export interface PersistedSignalOptions<T> {
  // Runs after the signal was updated from ANOTHER same-origin document (the
  // `storage` event path), with the re-read value. NOT run for local writes —
  // the local setter's caller owns its own side effects (apply-on-set). This
  // is the hook for values whose application is imperative (the theme:
  // .theme-* classes + inline vars on <html>): without it a remote change
  // updates the in-memory signal but the document keeps rendering the old
  // value until something else calls the imperative apply.
  onRemoteChange?: (value: T) => void;
}

// A Solid signal backed by versioned localStorage: hydrated from storage on
// init, and the returned setter persists on every write. Collapses the
// "createSignal(loadVersioned(...)) + a setter that calls saveVersioned" pattern
// that was hand-written for every preference. The setter takes a value (prefs
// don't use the updater form). Wrap it when a setter also has a side effect
// (e.g. apply the value to the DOM); pass `options.onRemoteChange` for the
// same side effect on the cross-document path.
//
// Cross-document sync: when more than one document on this origin holds the same
// pref (each host pane is a separate iframe document; each browser tab is a
// separate document), the writer's saveVersioned persists to the shared
// localStorage, and the browser fires a `storage` event in the OTHER documents
// (never in the writer). Without re-reading on that event, each document's
// in-memory signal diverges until a reload — the host-shell "settings in a
// window wont be sent to others, need to reload page" bug. The listener below
// re-runs the same loadVersioned parse path (so migration + fallback semantics
// are identical) and updates the signal via the RAW setter (NOT setSaved), so
// reacting to a write never echoes a second write (the storage event doesn't
// fire in the writer anyway, but using the raw setter keeps the stored bytes
// exactly what the other document wrote and avoids redundant work).
export function persistedSignal<T>(
  key: string,
  version: number,
  fallback: T,
  migrate?: (old: unknown, fromVersion: number) => T,
  options?: PersistedSignalOptions<T>,
): [Accessor<T>, (value: T) => void] {
  const [get, set] = createSignal<T>(loadVersioned(key, version, fallback, migrate));
  const setSaved = (value: T) => {
    set(() => value);
    saveVersioned(key, version, value);
  };
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("storage", (e: StorageEvent) => {
      if (e.key !== key) return;
      // Re-read through the shared parse/migrate path. localStorage is shared
      // same-origin, so by the time the event fires here our storage already
      // reflects the other document's write; loadVersioned reads it back out.
      const remote = loadVersioned(key, version, fallback, migrate);
      set(() => remote);
      // Re-run the consumer's imperative apply for the remote value (no-op
      // when none was given).
      options?.onRemoteChange?.(remote);
    });
  }
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
