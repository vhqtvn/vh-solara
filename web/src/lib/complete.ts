// Composer autocomplete data: file paths (@), agents (@), and slash commands (/).
export interface AcItem {
  kind: "agent" | "file" | "command";
  label: string;
  detail?: string;
  insert: string; // full replacement for the active token (incl. trigger char)
}

export async function fileSuggestions(query: string): Promise<AcItem[]> {
  if (!query) return [];
  try {
    const res = await fetch(`/oc/find/file?query=${encodeURIComponent(query)}`);
    if (!res.ok) return [];
    const arr = await res.json();
    return (Array.isArray(arr) ? arr : [])
      .slice(0, 8)
      .map((p: string) => ({ kind: "file" as const, label: p, insert: "@" + p + " " }));
  } catch {
    return [];
  }
}

// /command rarely changes within a session, so cache it after the first fetch.
let commandsCache: AcItem[] | null = null;
async function allCommands(): Promise<AcItem[]> {
  if (commandsCache) return commandsCache;
  let cmds: AcItem[] = [];
  try {
    const res = await fetch("/oc/command");
    if (res.ok) {
      const arr = await res.json();
      cmds = (Array.isArray(arr) ? arr : []).map((c: any) => ({
        kind: "command" as const,
        label: "/" + c.name,
        detail: c.description,
        insert: "/" + c.name + " ",
      }));
    }
  } catch {
    /* ignore */
  }
  // Local-only commands the composer handles directly.
  cmds.push(
    { kind: "command", label: "/undo", detail: "revert the last turn", insert: "/undo" },
    { kind: "command", label: "/redo", detail: "unrevert", insert: "/redo" },
  );
  commandsCache = cmds;
  return cmds;
}

export async function commandSuggestions(query: string): Promise<AcItem[]> {
  const q = query.toLowerCase();
  return (await allCommands()).filter((c) => c.label.toLowerCase().includes(q)).slice(0, 10);
}
