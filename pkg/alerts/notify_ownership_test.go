package alerts

// notify_ownership_test.go — lane-1 tests for the notify ownership startup
// fence (notify controller-hub S1 / v4 (j), §9.4): controller mode fences
// local FCM and persists the decision; missing/corrupt state in controller
// mode FAILS CLOSED; a standalone launch never clears a persisted controller
// fence; standalone mode preserves v3; watermark H stays null until S2/S3.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func readOwnershipRaw(t *testing.T, dir string) OwnershipState {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "notify-ownership.json"))
	if err != nil {
		t.Fatalf("ownership file: %v", err)
	}
	var st OwnershipState
	if err := json.Unmarshal(raw, &st); err != nil {
		t.Fatalf("ownership doc: %v", err)
	}
	return st
}

// TestOwnershipControllerModeFencesAndPersists pins the static fence: a
// controller-mode decision fences local FCM, persists mode=controller with a
// fenced_at stamp, and is idempotent (the original fenced_at survives).
func TestOwnershipControllerModeFencesAndPersists(t *testing.T) {
	dir := t.TempDir()
	d := DecideNotifyOwnership(dir, true)
	if !d.ControllerMode || !d.LocalFCMFenced {
		t.Fatalf("controller decision = %+v, want fenced", d)
	}
	st := readOwnershipRaw(t, dir)
	if st.Mode != OwnershipModeController || st.FencedAt == 0 {
		t.Fatalf("persisted state = %+v, want controller + fenced_at", st)
	}
	// Idempotent second decision keeps the original fenced_at.
	d2 := DecideNotifyOwnership(dir, true)
	if !d2.LocalFCMFenced || d2.Healed {
		t.Fatalf("second decision = %+v, want fenced + not healed", d2)
	}
	st2 := readOwnershipRaw(t, dir)
	if st2.FencedAt != st.FencedAt {
		t.Fatalf("fenced_at drifted across idempotent decisions: %d -> %d", st.FencedAt, st2.FencedAt)
	}
}

// TestOwnershipControllerModeMissingStateFailsClosed pins the fail-closed
// bar: no ownership file at all in controller mode ⇒ fenced (never a local
// fallback), with a visible disposition and a seeded state file.
func TestOwnershipControllerModeMissingStateFailsClosed(t *testing.T) {
	dir := t.TempDir()
	d := DecideNotifyOwnership(dir, true)
	if !d.LocalFCMFenced {
		t.Fatal("missing state in controller mode must fail CLOSED (fenced)")
	}
	if d.Note == "" {
		t.Fatal("fail-closed disposition must carry a visible note")
	}
	if st := readOwnershipRaw(t, dir); st.Mode != OwnershipModeController {
		t.Fatalf("healed state = %+v, want controller", st)
	}
}

// TestOwnershipControllerModeCorruptStateFailsClosed pins the corrupt-state
// bar: garbage in the ownership file in controller mode ⇒ fenced, visible,
// healed to a readable controller record.
func TestOwnershipControllerModeCorruptStateFailsClosed(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "notify-ownership.json")
	if err := os.WriteFile(path, []byte("{bad json"), 0o600); err != nil {
		t.Fatal(err)
	}
	d := DecideNotifyOwnership(dir, true)
	if !d.LocalFCMFenced || !d.Healed {
		t.Fatalf("corrupt state in controller mode = %+v, want fenced + healed", d)
	}
	if st := readOwnershipRaw(t, dir); st.Mode != OwnershipModeController {
		t.Fatalf("healed state = %+v, want controller", st)
	}
}

// TestOwnershipStandaloneKeepsV3 pins standalone posture: not fenced, state
// seeded standalone, v3 behavior preserved — including a corrupt file in
// standalone mode (fail-closed is a controller-mode requirement; an explicit
// standalone install keeps its channel).
func TestOwnershipStandaloneKeepsV3(t *testing.T) {
	dir := t.TempDir()
	d := DecideNotifyOwnership(dir, false)
	if d.LocalFCMFenced {
		t.Fatalf("standalone decision = %+v, want NOT fenced (v3)", d)
	}
	if st := readOwnershipRaw(t, dir); st.Mode != OwnershipModeStandalone {
		t.Fatalf("seeded state = %+v, want standalone", st)
	}
	// Idempotent.
	if d2 := DecideNotifyOwnership(dir, false); d2.LocalFCMFenced {
		t.Fatal("second standalone decision must stay unfenced")
	}

	// Corrupt state in standalone mode: v3 preserved + healed + visible.
	dir2 := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir2, "notify-ownership.json"), []byte("nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	d3 := DecideNotifyOwnership(dir2, false)
	if d3.LocalFCMFenced || !d3.Healed || d3.Note == "" {
		t.Fatalf("corrupt standalone state = %+v, want unfenced + healed + visible", d3)
	}
}

// TestOwnershipStandaloneAfterControllerStaysFenced pins §9.4's "a
// disconnect never restores local authority": a persisted controller fence
// survives a standalone relaunch — local FCM stays disabled with a visible
// disposition naming the explicit escape.
func TestOwnershipStandaloneAfterControllerStaysFenced(t *testing.T) {
	dir := t.TempDir()
	if d := DecideNotifyOwnership(dir, true); !d.LocalFCMFenced {
		t.Fatal("premise: controller decision must fence")
	}
	d := DecideNotifyOwnership(dir, false) // relaunch WITHOUT a controller
	if !d.LocalFCMFenced {
		t.Fatal("standalone relaunch must NOT clear a persisted controller fence")
	}
	if d.Note == "" {
		t.Fatal("stays-fenced disposition must be visible")
	}
	// The persisted record keeps mode=controller.
	if st := readOwnershipRaw(t, dir); st.Mode != OwnershipModeController {
		t.Fatalf("persisted mode = %q, want controller preserved", st.Mode)
	}
}

// TestOwnershipStandaloneToControllerFlipsAndFences pins the S1 cutover: a
// previously-standalone record flips to controller (fenced_at=now) when the
// daemon launches in controller mode — the graceful drain/H transfer is the
// S2/S3 protocol; S1 fences at startup.
func TestOwnershipStandaloneToControllerFlipsAndFences(t *testing.T) {
	dir := t.TempDir()
	if d := DecideNotifyOwnership(dir, false); d.LocalFCMFenced {
		t.Fatal("premise: standalone first launch must be unfenced")
	}
	d := DecideNotifyOwnership(dir, true)
	if !d.LocalFCMFenced || d.Healed {
		t.Fatalf("controller cutover = %+v, want fenced + not healed", d)
	}
	st := readOwnershipRaw(t, dir)
	if st.Mode != OwnershipModeController || st.FencedAt == 0 {
		t.Fatalf("cutover state = %+v, want controller + fresh fenced_at", st)
	}
}

// TestOwnershipWatermarkNullUntilTransfer pins the S1 state shape: the
// persisted document carries "watermark": null (the durable-watermark H is
// populated only by the S2/S3 transfer protocol).
func TestOwnershipWatermarkNullUntilTransfer(t *testing.T) {
	dir := t.TempDir()
	DecideNotifyOwnership(dir, true)
	raw, err := os.ReadFile(filepath.Join(dir, "notify-ownership.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	wm, ok := doc["watermark"]
	if !ok || string(wm) != "null" {
		t.Fatalf("watermark must be present and null in S1, got %s", wm)
	}
	st, ok := ReadNotifyOwnership(dir)
	if !ok || st.Watermark != nil {
		t.Fatalf("ReadNotifyOwnership = %+v ok=%v, want readable + nil H", st, ok)
	}
}

// TestOwnershipConcurrentControllerDecisionsAllFenced pins the H/fence race
// posture at init: concurrent decisions on the same state dir all fence (the
// verdict never depends on write ordering), and the file stays readable.
func TestOwnershipConcurrentControllerDecisionsAllFenced(t *testing.T) {
	dir := t.TempDir()
	const n = 8
	var wg sync.WaitGroup
	fenced := make([]bool, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			fenced[i] = DecideNotifyOwnership(dir, true).LocalFCMFenced
		}(i)
	}
	wg.Wait()
	for i, f := range fenced {
		if !f {
			t.Fatalf("concurrent decision %d did not fence", i)
		}
	}
	if st := readOwnershipRaw(t, dir); st.Mode != OwnershipModeController {
		t.Fatalf("post-race state = %+v, want readable controller record", st)
	}
}
