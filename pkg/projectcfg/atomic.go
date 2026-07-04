package projectcfg

import (
	"fmt"
	"os"
	"path/filepath"
)

// writeFileAtomic writes data to path atomically: it writes data to a temp file
// in the SAME directory as path, fsyncs the temp, closes it, applies perm, and
// renames it over path. On POSIX, rename is atomic, so a crash at any earlier
// point never leaves `path` truncated or partially written — at worst the temp
// lingers and the previous `path` is byte-intact. The temp file lives in
// path's directory because rename across directories is NOT atomic.
//
// Used for the daemon's writes to checked-in project.jsonc and the local
// overlay, where a non-atomic open+truncate+write (os.WriteFile) could truncate
// the declarative file on a mid-write crash and lose processes/views until a
// `git checkout`. fsync of the parent dir after rename is best-effort: it is
// ignored on filesystems that do not support it (e.g. tmpfs).
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	base := filepath.Base(path)

	// os.CreateTemp randomizes the suffix and creates the file with 0600; we
	// chmod to perm below before the rename so the final file lands right.
	tmp, err := os.CreateTemp(dir, "."+base+".tmp-*")
	if err != nil {
		return fmt.Errorf("projectcfg: atomic write %s: create temp: %w", path, err)
	}
	tmpName := tmp.Name()
	// Best-effort removal of the temp on any pre-rename error path.
	cleanup := func() { _ = os.Remove(tmpName) }

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("projectcfg: atomic write %s: write temp: %w", path, err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("projectcfg: atomic write %s: fsync temp: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("projectcfg: atomic write %s: close temp: %w", path, err)
	}
	// Apply perm to the temp (CreateTemp uses 0600). Done before the rename so
	// the atomically-swapped file already carries the right mode.
	if err := os.Chmod(tmpName, perm); err != nil {
		cleanup()
		return fmt.Errorf("projectcfg: atomic write %s: chmod temp: %w", path, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		cleanup()
		return fmt.Errorf("projectcfg: atomic write %s: rename: %w", path, err)
	}
	// Best-effort durability of the rename itself. Some filesystems cannot
	// fsync a directory (tmpfs returns EINVAL; some network filesystems return
	// ENOTSUP/ENOSYS); since this is best-effort durability rather than
	// correctness, every error from the dir fsync is swallowed.
	syncDirBestEffort(dir)
	return nil
}

// syncDirBestEffort opens dir and fsyncs it, ignoring all errors. It exists so
// the atomic rename is durable on filesystems that support directory fsync,
// without breaking on those that do not (or when the dir is not readable).
func syncDirBestEffort(dir string) {
	d, err := os.Open(dir)
	if err != nil {
		return
	}
	defer d.Close()
	_ = d.Sync()
}
