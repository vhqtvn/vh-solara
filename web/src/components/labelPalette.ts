// Label palette + tiny pure helpers shared by the slice-6 labels UI
// (SessionTree group header/dots, SessionContextMenu group/tag pickers, Sidebar
// filter chip rail). Co-located with the components that consume it; pure (no
// Solid, no DOM) so it is trivially unit-testable.
//
// The server (pkg/web/labels.go) validates group/tag colors against this EXACT
// fixed token set, so the UI MUST only ever offer these. The matching CSS vars
// live in styles/foundation/tokens.css (--label-<color>); modules consume them,
// never redefine them (per docs/ai/web-css-architecture.md §2).

// The canonical, server-validated color token set. Order is the palette cycle
// order for "New group…" / "New tag…" defaults (a pleasant rotation, not alpha-
// betical, so two quick creates land on visibly different hues).
export const LABEL_COLORS = [
  "blue",
  "green",
  "amber",
  "purple",
  "teal",
  "red",
  "orange",
  "gray",
] as const;

export type LabelColor = (typeof LABEL_COLORS)[number];

// labelColorVar — map a stored color token to its CSS var reference, with a
// gray fallback for an unknown/empty color (defensive: coerceLabelsDoc repairs
// to "" not "gray", and a stale/transient doc could carry an off-palette value
// the UI must never crash on). Returned string is suitable for a `style` binding
// like { "--label-color": labelColorVar(g.color) }.
export function labelColorVar(color: string | undefined | null): string {
  if (color && (LABEL_COLORS as readonly string[]).includes(color)) {
    return `var(--label-${color})`;
  }
  return "var(--label-gray)";
}

// defaultColorForIndex — the palette-cycle default for the Nth new group/tag.
// Deterministic + pure so two clients creating their first group both land on
// "blue"; the operator can change it in the picker. Wraps via modulo so an
// arbitrary index is always in range.
export function defaultColorForIndex(i: number): LabelColor {
  const idx = ((i % LABEL_COLORS.length) + LABEL_COLORS.length) % LABEL_COLORS.length;
  return LABEL_COLORS[idx];
}

// abbreviate — the 2–3 letter abbreviation shown on a tag chip (dot + abbr per
// the plan's UX layer). Takes the first alphanumeric word's leading chars so a
// tag like "backend-api" → "ba" and "Urgent" → "ur". Lowercased for visual
// quiet. Empty for an un-abbreviable name (caller hides the abbr span).
export function abbreviate(name: string, max = 2): string {
  const m = name.trim().match(/[a-z0-9]/i);
  if (!m) return "";
  const firstWord = name.trim().split(/[^a-z0-9]+/i)[0] ?? "";
  return firstWord.slice(0, max).toLowerCase();
}

// A tag chip as rendered on a root row. `overflow: true` marks the synthetic
// "+N" chip appended when a root carries more tags than the visible max — it
// renders WITHOUT a color dot (it is a count, not a tag).
export interface VisibleTagChip {
  id: string;
  name: string;
  color: string;
  overflow?: boolean;
}

// visibleTagChips — cap a root's full tag list to the visible maximum (2 by
// default per the plan's "max 2 + +N overflow" rule), appending a synthetic
// "+N" overflow chip when there are more. Pure + deterministic; unit-tested.
// Input order is preserved (the registry's array order, which is stable).
export function visibleTagChips(
  tags: readonly { id: string; name: string; color: string }[],
  max = 2,
): VisibleTagChip[] {
  if (tags.length <= max) return tags.slice();
  const shown = tags.slice(0, max).map((t) => ({ ...t }));
  const overflow = tags.length - max;
  return [
    ...shown,
    { id: "__label-overflow", name: `+${overflow}`, color: "gray", overflow: true },
  ];
}

