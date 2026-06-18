// Versioned localStorage. Every persisted value is wrapped as {v, data} so the
// schema can evolve: on read, a value at an older version is run through an
// optional migrate() (which also handles legacy unversioned values, passed with
// fromVersion 0), and a bad/foreign payload falls back cleanly. Writes are
// best-effort (private-mode / quota errors are swallowed).
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
