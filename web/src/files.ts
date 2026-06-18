// Global "open this file" target, used by clickable paths and the git view.
import { createSignal } from "solid-js";

export interface FileTarget {
  path: string;
  line?: number;
}

const [openTarget, setOpenTarget] = createSignal<FileTarget | null>(null);

export function openFile(path: string, line?: number) {
  setOpenTarget({ path, line });
}
export function closeFile() {
  setOpenTarget(null);
}
export { openTarget };
