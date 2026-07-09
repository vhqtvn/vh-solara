// Harvest pasted files from a paste event's clipboard data.
//
// Browsers are inconsistent about WHERE a pasted image/file surfaces: it
// frequently arrives ONLY via clipboardData.items (kind === "file" +
// getAsFile()), while clipboardData.files stays empty — so reading .files
// alone silently drops the paste (the "Ctrl+V does nothing" symptom).
//
// Strategy: prefer items (the superset of pasted data) and only fall back to
// .files when items yielded nothing. This covers the files-empty/items-only
// case AND avoids double-counting on browsers that populate both with the same
// file.

export type FileItem = { kind: string; getAsFile(): File | null };

export function harvestPastedFiles(
  files: readonly File[] | null | undefined,
  items: readonly FileItem[] | null | undefined,
): File[] {
  const out: File[] = [];
  if (items && items.length > 0) {
    for (const it of items) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  // Fall back to .files only when items yielded nothing (some browsers expose
  // files without a usable item list). Never union the two — on browsers that
  // populate both, that would attach the same file twice.
  if (out.length === 0 && files && files.length > 0) {
    for (const f of files) out.push(f);
  }
  return out;
}
