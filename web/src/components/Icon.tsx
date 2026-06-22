import { type JSX } from "solid-js";

// Minimal feather-style inline icons (stroke = currentColor), so the UI uses
// consistent, crisp iconography instead of cross-platform emoji.
//
// IMPORTANT: each entry is a FUNCTION returning fresh JSX, not a stored element.
// A Solid JSX element is a real DOM node created once; reusing one node across
// many <Icon> instances (e.g. a copy button on every message, or `plus` in both
// the sidebar and the notes panel) moves that single node to the last mount and
// leaves the others empty. Calling the function per render creates new nodes.
const PATHS: Record<string, () => JSX.Element> = {
  plus: () => <path d="M12 5v14M5 12h14" />,
  x: () => <path d="M18 6 6 18M6 6l12 12" />,
  menu: () => <path d="M3 6h18M3 12h18M3 18h18" />,
  settings: () => (
    <>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
      <path d="M1 14h6M9 8h6M17 16h6" />
    </>
  ),
  send: () => <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />,
  stop: () => <rect x="6" y="6" width="12" height="12" rx="1.5" />,
  maximize: () => (
    <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
  ),
  terminal: () => (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </>
  ),
  copy: () => (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </>
  ),
  clipboard: () => (
    <>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </>
  ),
  info: () => (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8h.01" />
    </>
  ),
  fork: () => (
    <>
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="6" cy="18" r="2.4" />
      <circle cx="18" cy="8" r="2.4" />
      <path d="M6 8.4v7.2M8.4 7q3.2 1 6.5 0M18 10.4c0 4-4 3.6-12 5.6" />
    </>
  ),
  retry: () => <path d="M21 12a9 9 0 1 1-3-6.7M21 4v4h-4" />,
  edit: () => <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />,
  chevronDown: () => <path d="m6 9 6 6 6-6" />,
  // Funnel — the tree's "show only running subtrees" (third) state.
  filter: () => <path d="M4 5h16l-6 8v6l-4-2v-4z" />,
  // Eye — the tree's "temporarily revealed to show the open session" state.
  eye: () => (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  wrap: () => (
    <>
      <path d="M3 6h18M3 12h13a3 3 0 0 1 0 6h-4M3 18h3" />
      <path d="m9 15-3 3 3 3" />
    </>
  ),
  arrowDown: () => <path d="M12 5v14M19 12l-7 7-7-7" />,
  paperclip: () => (
    <path d="M21.4 11.05 12.2 20.2a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 0 1 4.24 4.24l-9.2 9.19a1 1 0 0 1-1.41-1.41l8.48-8.49" />
  ),
  bell: () => <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />,
  check: () => <path d="M20 6 9 17l-5-5" />,
  help: () => (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 2.5M12 17h.01" />
    </>
  ),
  layers: () => <path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />,
};

export default function Icon(props: { name: keyof typeof PATHS | string; size?: number }) {
  const draw = () => PATHS[props.name];
  return (
    <svg
      class="icon"
      viewBox="0 0 24 24"
      width={props.size ?? 16}
      height={props.size ?? 16}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {draw()?.()}
    </svg>
  );
}
