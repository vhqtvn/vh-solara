//go:build linux

package cmd

import (
	"strconv"
	"unsafe"

	"golang.org/x/sys/unix"
)

// ocWatchNoWaitid reports whether this platform lacks the waitid fast path.
const ocWatchNoWaitid = false

// ocSiginfoStatusOffset is the byte offset of the exit status inside
// siginfo's _sigchld union (kernel ABI, uapi asm-generic/siginfo.h): the
// fixed header is {int signo; int errno; int code;} (12 bytes), then the
// union follows — immediately on 32-bit ABIs (si_pid@12, si_uid@16,
// si_status@20) and after 4 alignment bytes on 64-bit ABIs (si_pid@16,
// si_uid@20, si_status@24). strconv.IntSize is an untyped constant — 64 on
// 64-bit GOARCHes (amd64/arm64/…, offset 24) and 32 on 32-bit ones
// (386/arm/…, offset 20) — so this resolves per-GOARCH at compile time.
// The release workflow ships linux-386 and linux-arm, where offset 24
// would read si_uid as the status. x/sys Siginfo does not surface the
// union, hence the unsafe read at this offset.
const ocSiginfoStatusOffset = 20 + 4*(strconv.IntSize/64)

// siginfo si_code values for a SIGCHLD event (linux uapi siginfo.h; stable
// kernel ABI — x/sys does not export them).
const (
	ocSiCodeCLDExited = 1 // CLD_EXITED
	ocSiCodeCLDKilled = 2 // CLD_KILLED
	ocSiCodeCLDDumped = 3 // CLD_DUMPED
)

// ocPollParentExit polls a child WE spawned for exit WITHOUT reaping it:
// waitid(P_PID, WEXITED|WNOHANG|WNOWAIT) reports the exit status while
// leaving the child a zombie — the no-reap invariant (an unreaped zombie
// keeps its pid unreusable, so curPID signaling can never hit a recycled
// pid) is preserved and asserted by TestOCWatchSignalKillDetectedNotReaped.
// (wait4(2) does NOT accept WNOWAIT — EINVAL on this kernel — so waitid is
// the only stdlib-adjacent no-reap poll.)
//
// Returns (exited, exitCode, signal, ourChild). ourChild=false means the
// pid is not our child (ECHILD — e.g. an instance a previous daemon
// spawned, now parented to init) and the caller must fall back to the
// identity poll.
func ocPollParentExit(pid int) (exited bool, code, sig *int, ourChild bool) {
	var si unix.Siginfo
	err := unix.Waitid(unix.P_PID, pid, &si, unix.WEXITED|unix.WNOHANG|unix.WNOWAIT, nil)
	if err != nil {
		// ECHILD: not our child. Any other error is treated the same way —
		// the identity poll still observes liveness honestly.
		return false, nil, nil, false
	}
	// With WNOHANG and no waitable event the kernel zeroes siginfo, and
	// si_code==0 never occurs for a real CLD_* event (CLD_EXITED..CLD_TRAP
	// are 1..6), so Code==0 unambiguously means "ours and still running".
	if si.Code == 0 {
		return false, nil, nil, true
	}
	// x/sys Siginfo does not surface the sigchld union; see
	// ocSiginfoStatusOffset for the per-GOARCH kernel-ABI basis. Verified
	// against this kernel by probe (si_pid cross-checked with the target
	// pid).
	status := int(*(*int32)(unsafe.Pointer(uintptr(unsafe.Pointer(&si)) + ocSiginfoStatusOffset)))
	switch si.Code {
	case ocSiCodeCLDExited: // CLD_EXITED: normal exit, status is the exit code
		return true, &status, nil, true
	case ocSiCodeCLDKilled, ocSiCodeCLDDumped: // CLD_KILLED/CLD_DUMPED: signal death, status is the signal
		return true, nil, &status, true
	default:
		// CLD_STOPPED/CLD_CONTINUED/CLD_TRAPPED cannot be reported with our
		// flag set (no WSTOPPED/WCONTINUED/WTRAPPED); treat defensively.
		return true, nil, nil, true
	}
}
