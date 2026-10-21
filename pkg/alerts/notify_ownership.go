package alerts

// notify_ownership.go — the notify ownership fence (notify controller-hub S1 /
// v4 (j), §9.4). A controller-mode worker starts with local FCM DISABLED,
// before the tunnel agent connects: the decision is applied at alerts-init
// time (InitAlerts runs before agent.NewDaemon — cmd/client-daemon.go:65-73),
// so there is no window in which local FCM could send while a controller owns
// delivery.
//
// Fail-closed (§9.4): in controller mode, a missing or corrupt ownership file
// keeps local FCM disabled (with a visible disposition note) — NEVER a
// fallback to local sending on uncertainty. A controller disconnect or
// reconnect can never revive local FCM: the sender is simply never attached
// while the fence holds, and no runtime path re-attaches it.
//
// The persisted decision lives at <stateDir>/notify-ownership.json:
//
//	{"mode": "controller"|"standalone", "fenced_at": <millis>, "watermark": null}
//
// mode is the LAST LAUNCH posture that won: launching in controller mode
// writes/keeps mode=controller; a standalone launch never clears a persisted
// controller fence (v4: "a disconnect never restores local authority";
// returning a centralized worker to standalone delivery requires the explicit
// coordinated transfer protocol — S2/S3). For S1 the documented operator
// escape is: stop the daemon, remove notify-ownership.json, relaunch with
// --controller "" (equivalent to a first-run standalone install).
// watermark H stays null until the S2/S3 transfer protocol populates it
// (local delivery at/below H, central dispatch above H).

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Ownership file modes.
const (
	OwnershipModeController = "controller"
	OwnershipModeStandalone = "standalone"
	ownershipFile           = "notify-ownership.json"
)

// OwnershipState is the persisted fence decision (<stateDir>/notify-ownership.json).
type OwnershipState struct {
	Mode      string `json:"mode"`      // controller | standalone
	FencedAt  int64  `json:"fenced_at"` // epoch millis the controller fence FIRST engaged (0 = never)
	Watermark *int64 `json:"watermark"` // durable watermark H; null until the S2/S3 transfer protocol
}

// OwnershipDecision is the startup-fence verdict for the local FCM sender,
// with a human-readable disposition for the health log.
type OwnershipDecision struct {
	ControllerMode bool   // the daemon is configured to connect to a controller
	LocalFCMFenced bool   // controller mode (or a persisted controller fence) ⇒ true
	Healed         bool   // a missing/corrupt state file was rewritten
	Note           string // visible disposition (logged by the caller)
}

// ownershipPath returns the fence state path under stateDir.
func ownershipPath(stateDir string) string {
	return filepath.Join(stateDir, ownershipFile)
}

// loadOwnership reads the persisted state. ok=false when missing or corrupt.
func loadOwnership(stateDir string) (OwnershipState, bool) {
	raw, err := os.ReadFile(ownershipPath(stateDir))
	if err != nil {
		return OwnershipState{}, false
	}
	var st OwnershipState
	if json.Unmarshal(raw, &st) != nil {
		return OwnershipState{}, false
	}
	if st.Mode != OwnershipModeController && st.Mode != OwnershipModeStandalone {
		return OwnershipState{}, false
	}
	return st, true
}

// writeOwnership persists st atomically (tmp + rename, 0600).
func writeOwnership(stateDir string, st OwnershipState) error {
	path := ownershipPath(stateDir)
	out, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// DecideNotifyOwnership applies the startup fence for THIS launch posture and
// returns the verdict. controllerMode is the daemon's connect configuration
// (a non-empty controller URL). The function is idempotent; concurrent calls
// on the same stateDir converge (controller mode fences regardless of which
// write lands, so the fail-closed verdict never depends on write ordering).
//
// Semantics:
//   - controller mode: local FCM fenced, always. Missing/corrupt state is
//     healed to a fresh controller record (visible via Healed+Note). An
//     existing controller record keeps its original fenced_at (when the fence
//     first engaged). A record left at standalone is flipped to controller
//     with fenced_at=now — S1 fences immediately on the mode flip; the
//     graceful drain/H-transfer refinement is the S2/S3 protocol.
//   - standalone mode: a persisted controller record KEEPS the worker fenced
//     (never restore local authority on a mere launch-flag change). Missing,
//     corrupt, or standalone state ⇒ not fenced (v3 behavior preserved);
//     corrupt state in standalone mode is healed to standalone with a visible
//     note (fail-closed is a controller-mode requirement; an explicitly
//     standalone install keeps its v3 channel).
func DecideNotifyOwnership(stateDir string, controllerMode bool) OwnershipDecision {
	if controllerMode {
		st, ok := loadOwnership(stateDir)
		switch {
		case !ok:
			// Missing or corrupt: fail closed + heal with a fresh record.
			fresh := OwnershipState{Mode: OwnershipModeController, FencedAt: time.Now().UnixMilli()}
			note := "notify ownership state missing/corrupt in controller mode: local FCM fenced (fail-closed), state re-seeded"
			if werr := writeOwnership(stateDir, fresh); werr != nil {
				note = fmt.Sprintf("notify ownership state missing/corrupt in controller mode: local FCM fenced (fail-closed); re-seed write failed: %v", werr)
			}
			return OwnershipDecision{ControllerMode: true, LocalFCMFenced: true, Healed: true, Note: note}
		case st.Mode == OwnershipModeController:
			// Fence already engaged (keep the original fenced_at).
			return OwnershipDecision{ControllerMode: true, LocalFCMFenced: true,
				Note: "controller mode: local FCM fenced (central delivery owns dispatch)"}
		default: // persisted standalone, now controller mode
			st.Mode = OwnershipModeController
			st.FencedAt = time.Now().UnixMilli()
			note := "daemon moved to controller mode: local FCM fenced at startup (H transfer lands in a later slice)"
			if werr := writeOwnership(stateDir, st); werr != nil {
				note = fmt.Sprintf("daemon moved to controller mode: local FCM fenced at startup; ownership persist failed: %v", werr)
			}
			return OwnershipDecision{ControllerMode: true, LocalFCMFenced: true, Note: note}
		}
	}
	// Standalone launch.
	st, ok := loadOwnership(stateDir)
	if ok && st.Mode == OwnershipModeController {
		// Persisted controller fence: NEVER unfence on a launch-flag change.
		return OwnershipDecision{ControllerMode: false, LocalFCMFenced: true,
			Note: "standalone launch, but notify ownership is controller-fenced: local FCM stays disabled (explicit coordinated transfer required; S1 escape: stop daemon, remove notify-ownership.json, relaunch standalone)"}
	}
	if !ok {
		// Missing or corrupt: v3 posture (explicit standalone), seeded/healed.
		fresh := OwnershipState{Mode: OwnershipModeStandalone}
		note := "notify ownership state missing/corrupt in standalone mode: v3 local FCM preserved, state seeded"
		if werr := writeOwnership(stateDir, fresh); werr != nil {
			note = fmt.Sprintf("notify ownership state missing/corrupt in standalone mode: v3 local FCM preserved; seed write failed: %v", werr)
		}
		return OwnershipDecision{ControllerMode: false, LocalFCMFenced: false, Healed: true, Note: note}
	}
	return OwnershipDecision{ControllerMode: false, LocalFCMFenced: false,
		Note: "standalone mode: local FCM active (v3 behavior)"}
}

// ReadNotifyOwnership returns the persisted ownership state (ok=false when
// missing/corrupt) — the surface later slices (S2/S3 H transfer) build on.
func ReadNotifyOwnership(stateDir string) (OwnershipState, bool) {
	return loadOwnership(stateDir)
}
