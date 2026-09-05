package e2e

// restart_orphan_heal_test.go — P1-API-007 end-to-end crux: a turn running
// when OpenCode dies mid-run (process killed by a UI-triggered restart, a
// crash, or a reboot) leaves its in-flight assistant message permanently
// unmarked — OpenCode re-serves the row with no time.completed and no error
// forever, the UI silently truncates the turn. The store-side
// interrupted-marker sweep must heal it: once the (restarted) instance is
// back and AUTHORITATIVELY reports the session not-busy, the turn is marked
// completed + interrupted so the UI renders the real outcome.
//
// Process death is MODELLED with the fixture's SilentClearBusyForTest seam
// (busy map cleared, no terminal event ever emitted — exactly the residue a
// kill leaves) followed by a real /vh/reload → aggregator Rehydrate over the
// live fake (the same hydrate a reconnect performs after the process comes
// back). This is NOT a real SIGKILL of an OpenCode process; it exercises the
// same observable store path one induces.

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/state"
)

func TestE2E_RestartOrphanHeal(t *testing.T) {
	// 1. Spawn a session over the tunnel (default dir aggregator).
	resp, body, err := cluster.Do(http.MethodPost, wpath("/sessions"),
		`{"title":"restart-orphan-heal"}`, cluster.APIToken, nil)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("spawn want 200, got %v: %s", statusOf(resp), body)
	}
	var sp struct {
		OK        bool   `json:"ok"`
		SessionID string `json:"sessionID"`
	}
	_ = json.Unmarshal(body, &sp)
	if !sp.OK || sp.SessionID == "" {
		t.Fatalf("spawn result unexpected: %s", body)
	}
	sid := sp.SessionID

	// 2. The turn goes busy (deterministic fixture seam through the real
	// /event stream — no [[stall]] sleep).
	cluster.Fake.EmitSessionBusy(sid)
	waitGateActivity(t, sid, "busy")

	// 3. The in-flight assistant row lands (persisted uncompleted in the
	// fake — what OpenCode's DB holds mid-turn).
	mid := cluster.Fake.PlantInflightAssistantForTest(sid)

	// Poll the worker snapshot until the planted row is resident, and pin
	// that it is NOT yet terminal (the defect's premise).
	snapshotURL := cluster.WorkerVHURL + "/vh/snapshot?sessions=" + sid
	plantedDeadline := time.Now().Add(10 * time.Second)
	resident := false
	for time.Now().Before(plantedDeadline) && !resident {
		r, err := http.Get(snapshotURL)
		if err != nil {
			t.Fatalf("snapshot GET: %v", err)
		}
		raw, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if completed, errName, ok := messageTerminal(raw, sid, mid); ok {
			if completed || errName != "" {
				t.Fatalf("planted row is already terminal before the kill model: completed=%v error=%q", completed, errName)
			}
			resident = true
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !resident {
		t.Fatalf("planted assistant %s never became resident in the worker store", mid)
	}

	// 4. The kill model: the process dies mid-turn. The instance (as
	// restarted) reports the session not-busy and NO terminal ever arrives.
	cluster.Fake.SilentClearBusyForTest(sid)

	// 5. Reconnect + hydrate over the live instance (what the aggregator
	// does after a restart): POST /vh/reload → Rehydrate → ListSessions +
	// statuses + messages → SetActivityFromStatuses clear path → sweep.
	// Driven on the worker's own vh server (the coordinator's fixed
	// /api/workers route table has no reload passthrough; the crux under
	// test is the worker's store heal, not the proxy hop).
	//
	// d-F1 stability gate: the sweep fires only on the SECOND consecutive
	// not-busy statuses observation (a turn starting between a fetch and its
	// application must not be false-marked). Reload #1 is observation 1
	// (hydrate); reload #2 is the confirming observation (in production the
	// next 60s reconcile tick, or the next reconnect, confirms — whichever
	// comes first). This is the coherent heal latency, documented in the
	// slice closeout.
	for i := 0; i < 2; i++ {
		reloadReq, _ := http.NewRequest(http.MethodPost, cluster.WorkerVHURL+"/vh/reload", nil)
		reloadReq.Header.Set("X-VH-CSRF", "1")
		if resp, err := http.DefaultClient.Do(reloadReq); err != nil || resp.StatusCode != 200 {
			t.Fatalf("reload #%d want 200, got %v (%v)", i+1, statusOf(resp), err)
		}
	}

	// 6. CRUX — the orphaned turn is healed: completed + our interrupted
	// marker, visible through the worker store's public snapshot.
	healDeadline := time.Now().Add(10 * time.Second)
	healed := false
	for time.Now().Before(healDeadline) && !healed {
		r, err := http.Get(snapshotURL)
		if err != nil {
			t.Fatalf("snapshot GET: %v", err)
		}
		raw, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if completed, errName, ok := messageTerminal(raw, sid, mid); ok {
			if completed && errName == state.InterruptedTurnErrorName {
				healed = true
				break
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !healed {
		t.Fatalf("CRUX FAIL: mid-turn kill not healed — assistant %s still unmarked after reload+hydrate (the P1-API-007 silent truncation)", mid)
	}

	// 7. The session itself is idle again (the gate reflects the heal).
	waitGateActivity(t, sid, "idle")
}

// messageTerminal extracts (time.completed?, error.name) for message mid in
// session sid from a /vh/snapshot body. ok=false → not resident yet.
func messageTerminal(raw []byte, sid, mid string) (completed bool, errName string, ok bool) {
	var snap struct {
		Messages map[string][]struct {
			Info struct {
				ID   string `json:"id"`
				Time struct {
					Completed *float64 `json:"completed"`
				} `json:"time"`
				Error *struct {
					Name string `json:"name"`
				} `json:"error"`
			} `json:"info"`
		} `json:"messages"`
	}
	if json.Unmarshal(raw, &snap) != nil {
		return false, "", false
	}
	for _, m := range snap.Messages[sid] {
		if m.Info.ID == mid {
			name := ""
			if m.Info.Error != nil {
				name = m.Info.Error.Name
			}
			return m.Info.Time.Completed != nil, name, true
		}
	}
	return false, "", false
}
