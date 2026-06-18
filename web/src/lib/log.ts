// Gated debug logging for the frontend. Off by default so production consoles
// stay quiet; flip it on in the field without a rebuild via the console:
//
//   vhDebug(true)    // persists in localStorage, survives reloads
//   vhDebug(false)
//
// debug/info are dropped unless enabled; warn/error always print (they signal
// real problems). Each call is scoped: console shows `[vh:sync] …`.
const KEY = "vh.debug";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

let on = read();

export function setDebug(v: boolean): void {
  on = v;
  try {
    if (v) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode / storage disabled — keep the in-memory flag */
  }
}

export function debugEnabled(): boolean {
  return on;
}

export const log = {
  debug: (scope: string, ...a: unknown[]) => {
    if (on) console.debug(`[vh:${scope}]`, ...a);
  },
  info: (scope: string, ...a: unknown[]) => {
    if (on) console.info(`[vh:${scope}]`, ...a);
  },
  warn: (scope: string, ...a: unknown[]) => console.warn(`[vh:${scope}]`, ...a),
  error: (scope: string, ...a: unknown[]) => console.error(`[vh:${scope}]`, ...a),
};

// Expose a runtime toggle for field debugging.
if (typeof window !== "undefined") {
  (window as unknown as { vhDebug: (v: boolean) => void }).vhDebug = setDebug;
}
