// Thin helpers for OpenCode calls through the daemon's /oc passthrough.
async function get<T = any>(path: string): Promise<T | null> {
  try {
    const r = await fetch("/oc" + path);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
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
    if (!r.ok) return null;
    return (await r.json().catch(() => ({}))) as T;
  } catch {
    return null;
  }
}

export const oc = { get, post };
