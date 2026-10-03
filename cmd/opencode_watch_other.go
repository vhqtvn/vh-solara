//go:build !linux

package cmd

// ocWatchNoWaitid reports whether this platform lacks the waitid fast path.
// Non-Linux builds have no waitid(WNOWAIT) equivalent, so EVERY target —
// including children we spawned — is watched through the shared identity
// poll.
const ocWatchNoWaitid = true

// ocPollParentExit: no wait fast path on this platform; the caller falls
// back to the identity poll (alive + cmdline + starttime). LIMITATION, so
// Linux is the fully-supported death-watch platform: on /proc-less systems
// (e.g. macOS) kill(pid,0) SUCCEEDS on a zombie and ocCmdlineMatches fails
// OPEN on the unreadable /proc/<pid>/cmdline (returns true on non-/proc
// errors) — so a daemon-spawned child that died can stay classified alive
// indefinitely. Only the process-gone-entirely case (kill fails with ESRCH)
// is detected. This mirrors the degenerate guard pattern of
// opencode_lock_other.go.
func ocPollParentExit(pid int) (exited bool, code, sig *int, ourChild bool) {
	return false, nil, nil, false
}
