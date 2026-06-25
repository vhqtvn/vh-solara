// Thin helpers for OpenCode calls through the daemon's /oc passthrough.
// Failures return null but are logged (warn) — they used to vanish silently,
// which made an empty result indistinguishable from a failed one.
import { log } from "./lib/log";

async function get<T = any>(path: string): Promise<T | null> {
  try {
    const r = await fetch("/oc" + path);
    if (!r.ok) {
      log.warn("oc", `GET ${path} → HTTP ${r.status}`);
      return null;
    }
    return (await r.json()) as T;
  } catch (e) {
    log.warn("oc", `GET ${path} failed`, e);
    return null;
  }
}

async function post<T = any>(path: string, body?: unknown): Promise<T | null> {
  try {
    const r = await fetch("/oc" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) {
      log.warn("oc", `POST ${path} → HTTP ${r.status}`);
      return null;
    }
    return (await r.json().catch(() => ({}))) as T;
  } catch (e) {
    log.warn("oc", `POST ${path} failed`, e);
    return null;
  }
}

export const oc = { get, post };
