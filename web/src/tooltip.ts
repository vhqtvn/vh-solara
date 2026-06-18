// Tooltip coordination. On a hover-capable pointer (mouse) tooltips show on
// hover as usual; on touch (the Fold/phones) auto-tooltips are suppressed — they
// otherwise stick after a tap — and the draggable "?" inspector drives them
// instead: drag it over an element and inspectAt tracks the pointer so the
// tooltip for whatever is underneath shows.
import { createSignal } from "solid-js";

export const hoverCapable =
  typeof matchMedia !== "undefined" && matchMedia("(hover: hover) and (pointer: fine)").matches;

export const [inspectAt, setInspectAt] = createSignal<{ x: number; y: number } | null>(null);
