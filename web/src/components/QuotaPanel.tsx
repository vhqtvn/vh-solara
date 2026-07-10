import { createResource, For, Show } from "solid-js";
import styles from "./QuotaPanel.module.css";

// Multi-provider usage quota, fetched from the daemon's /vh/quota (which reads
// OpenCode's stored credentials and calls each provider's usage endpoint).
// Pace/prediction is computed here from the window's used% vs elapsed time.

interface QuotaWindow {
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  valueLabel?: string;
}
interface QuotaProvider {
  providerId: string;
  providerName: string;
  ok: boolean;
  configured: boolean;
  windows: QuotaWindow[];
  error?: string;
}
interface QuotaReport {
  providers: QuotaProvider[];
  fetchedAt: number;
}

// Infer a window length when the API doesn't report one, from its label.
function windowLen(w: QuotaWindow): number | null {
  if (w.windowSeconds && w.windowSeconds > 0) return w.windowSeconds;
  const m: Record<string, number> = {
    "5h": 5 * 3600,
    "7d": 7 * 86400,
    "7d-sonnet": 7 * 86400,
    "7d-opus": 7 * 86400,
    weekly: 7 * 86400,
    daily: 86400,
  };
  return m[w.label] ?? null;
}

function fmtDuration(sec: number): string {
  if (sec <= 0) return "now";
  const h = Math.floor(sec / 3600);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d}d ${h % 24}h`;
  if (h >= 1) return `${h}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.max(1, Math.floor(sec / 60))}m`;
}

// Pace: compare used% against the fraction of the window already elapsed.
// If you're spending faster than the clock, predict when you'll hit 100%.
function pace(w: QuotaWindow): { label: string; tone: "ok" | "warn" | "hot" } | null {
  if (w.usedPercent == null || w.resetAfterSeconds == null) return null;
  const len = windowLen(w);
  if (!len) return null;
  const elapsed = len - w.resetAfterSeconds;
  if (elapsed <= 0) return { label: "on pace", tone: "ok" };
  const rate = w.usedPercent / elapsed; // %/sec
  if (rate <= 0) return { label: "on pace", tone: "ok" };
  const secsToFull = (100 - w.usedPercent) / rate;
  if (secsToFull < w.resetAfterSeconds) {
    // Will exhaust before the window resets.
    return { label: `exhausts in ~${fmtDuration(secsToFull)} (before reset)`, tone: secsToFull < 3600 ? "hot" : "warn" };
  }
  return { label: "on pace", tone: "ok" };
}

async function fetchQuota(): Promise<QuotaReport> {
  const res = await fetch("/vh/quota");
  return res.json();
}

export default function QuotaPanel() {
  const [data, { refetch }] = createResource(fetchQuota);

  return (
    <div class={styles.quota}>
      <div class={styles["quota-head"]}>
        <p class="setting-hint" style={{ margin: 0, flex: 1 }}>
          Live quota from each provider's usage API (via OpenCode credentials).
        </p>
        <button type="button" class={styles["quota-refresh"]} onClick={() => refetch()}>
          Refresh
        </button>
      </div>

      <Show when={data()} fallback={<p class="setting-hint">Loading usage…</p>}>
        <Show
          when={data()!.providers.length > 0}
          fallback={
            <p class="setting-hint">
              No supported provider credentials found. Quota is available for Claude (Pro/Max), Codex
              (ChatGPT), and OpenRouter when you're signed in via OpenCode.
            </p>
          }
        >
          <For each={data()!.providers}>
            {(p) => (
              <div class={styles["quota-card"]}>
                <div class={styles["quota-card-head"]}>
                  <span class="quota-name">{p.providerName}</span>
                  <Show when={!p.ok}>
                    <span class={styles["quota-err"]}>{p.error || "unavailable"}</span>
                  </Show>
                </div>
                <Show when={p.ok && p.windows.length > 0}>
                  <For each={p.windows}>
                    {(w) => {
                      const pc = pace(w);
                      return (
                        <div class={styles["quota-win"]}>
                          <div class={styles["quota-win-top"]}>
                            <span class="quota-win-label">{w.label}</span>
                            <span class={styles["quota-win-val"]}>
                              {w.usedPercent != null ? `${Math.round(w.usedPercent)}% used` : w.valueLabel || "—"}
                            </span>
                          </div>
                          <Show when={w.usedPercent != null}>
                            <div class={styles["quota-bar"]}>
                              <div
                                class={styles["quota-fill"]}
                                classList={{ warn: (w.usedPercent ?? 0) >= 75, hot: (w.usedPercent ?? 0) >= 90 }}
                                style={{ width: `${Math.min(100, w.usedPercent ?? 0)}%` }}
                              />
                            </div>
                          </Show>
                          <div class={styles["quota-meta"]}>
                            <Show when={w.valueLabel && w.usedPercent != null}>
                              <span>{w.valueLabel}</span>
                            </Show>
                            <Show when={w.resetAfterSeconds != null}>
                              <span>resets in {fmtDuration(w.resetAfterSeconds!)}</span>
                            </Show>
                            <Show when={pc}>
                              <span class={`quota-pace ${pc!.tone}`}>{pc!.label}</span>
                            </Show>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}
