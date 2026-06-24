// Client API for the daemon-side notifications/alerts system. Secrets are
// write-only: the server returns `hasSecret` (never the value); send a secret
// only to set/change one, leave it empty to keep the stored one.

export type ChannelPolicy = "always" | "when_unattended" | "never";
export type DeviceScope = "off" | "current" | "all";

export interface AlertChannel {
  id: string;
  type: string;
  url: string;
  enabled: boolean;
  hasSecret?: boolean; // from server (masked)
  secret?: string; // outbound only (a new/changed secret)
}

export interface AlertProfile {
  name: string;
  channels: string[];
  channel_policy: ChannelPolicy;
  device_scope: DeviceScope;
  types: string[] | null;
}

export interface AlertDetect {
  finished_settle_sec: number;
  think_sec: number;
  command_sec: number;
  stalled_sec: number;
  cooldown_sec: number;
  idle_sec: number;
}

export interface AlertConfig {
  channels: AlertChannel[];
  profiles: AlertProfile[];
  active_profile: string;
  detect: AlertDetect;
}

export interface PresenceDevice {
  id: string;
  name?: string;
  focusedRoot?: string;
  scope?: string;
  lastInteraction: string;
  lastSeen: string;
  idle: boolean;
}

const POST = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
    body: JSON.stringify(body),
  });

export async function getAlertConfig(): Promise<AlertConfig | null> {
  try {
    const r = await fetch("/vh/alerts/config");
    return r.ok ? ((await r.json()) as AlertConfig) : null;
  } catch {
    return null;
  }
}

export async function saveAlertConfig(cfg: AlertConfig): Promise<AlertConfig | null> {
  try {
    const r = await fetch("/vh/alerts/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
      body: JSON.stringify(cfg),
    });
    return r.ok ? ((await r.json()) as AlertConfig) : null;
  } catch {
    return null;
  }
}

export async function setActiveProfile(name: string): Promise<boolean> {
  try {
    return (await POST("/vh/alerts/profile", { name })).ok;
  } catch {
    return false;
  }
}

export async function sendTestChannel(channel: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const r = await POST("/vh/alerts/test", { channel });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, ...j };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function heartbeat(d: {
  id: string;
  name?: string;
  focusedRoot?: string;
  scope?: string;
  lastInteraction?: string;
  idle?: boolean;
}): Promise<{ attended: boolean } | null> {
  try {
    const r = await POST("/vh/alerts/presence", d);
    return r.ok ? ((await r.json()) as { attended: boolean }) : null;
  } catch {
    return null;
  }
}

export async function listDevices(): Promise<PresenceDevice[]> {
  try {
    const r = await fetch("/vh/alerts/devices");
    if (!r.ok) return [];
    const j = (await r.json()) as { devices: PresenceDevice[] };
    return j.devices || [];
  } catch {
    return [];
  }
}
