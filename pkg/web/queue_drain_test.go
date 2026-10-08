package web

// Attempt-journal writer tests (send-net-resilience slice 2a): crash-at-
// each-transition journal survival, transport classification, the executor's
// receipt discipline (exactly one receipt per attempt, no auto-action), and
// the flag-OFF byte-equivalence contract (custody disabled ⇒ the durable
// file carries NO custody artifacts).

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// reloadQueueStore returns a FRESH store over the same queue file — the
// post-crash reloader's-eye view (no in-memory state from the dead writer).
func reloadQueueStore(t *testing.T, s *sessionQueueStore) *sessionQueueStore {
	t.Helper()
	return &sessionQueueStore{path: s.path}
}

// journalItemByText reloads the queue from DISK and returns the item with the
// given text, failing the test if the durable state does not contain it.
func journalItemByText(t *testing.T, s *sessionQueueStore, text string) QueueItem {
	t.Helper()
	items, err := reloadQueueStore(t, s).List()
	if err != nil {
		t.Fatalf("reload List: %v", err)
	}
	for _, it := range items {
		if it.Text == text {
			return it
		}
	}
	t.Fatalf("no item with text %q in durable queue (%d items)", text, len(items))
	return QueueItem{}
}

// TestQueueDrainCrashAtEachTransition is the CRUX crash-proof for the
// write-ahead journal: kill the writer at every transition boundary and
// assert the durable state on reload is EXACTLY the last transition that
// completed. "Crash" = abandon the in-memory store (the process died) +
// release custody (the kernel frees the flock) + reload through a fresh
// store under a NEW custody generation — the full post-crash posture.
func TestQueueDrainCrashAtEachTransition(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	root := custodyTestRoot(t)
	path := queuePath(root, "s1")

	// --- CRASH AFTER CLAIM ("prepared" is durable; no attempt began) ---
	tok1, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	s1 := &sessionQueueStore{path: path}
	if _, err := s1.Enqueue("crash-probe", nil, QueueSendConfig{}, ""); err != nil {
		t.Fatal(err)
	}
	claimed, won, err := s1.ClaimForCustody(tok1)
	if err != nil || !won {
		t.Fatalf("claim: err=%v won=%v", err, won)
	}
	mintedID := claimed.OpencodeMsgID
	if mintedID == "" {
		t.Fatal("claim did not mint the correlation id")
	}
	tok1.Release() // CRASH

	it := journalItemByText(t, s1, "crash-probe")
	if it.State != QueueDispatching {
		t.Fatalf("after crash-at-claim state = %s, want dispatching (prepared is durable)", it.State)
	}
	if len(it.Attempts) != 0 {
		t.Fatalf("after crash-at-claim attempts = %d, want 0 (no attempt began)", len(it.Attempts))
	}

	// --- CRASH AFTER BEGIN (the `prepared → sending` write-ahead record is
	// durable; the POST never happened) ---
	tok2, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	if tok2.Generation() <= tok1.Generation() {
		t.Fatalf("epoch 2 generation = %d, want > %d (monotonic across crash)", tok2.Generation(), tok1.Generation())
	}
	s2 := &sessionQueueStore{path: path}
	if _, err := s2.BeginDispatchAttempt(tok2, it.ID); err != nil {
		t.Fatalf("begin attempt: %v", err)
	}
	tok2.Release() // CRASH before the POST

	it = journalItemByText(t, s2, "crash-probe")
	if it.State != QueueDispatching {
		t.Fatalf("after crash-at-begin state = %s, want dispatching", it.State)
	}
	if len(it.Attempts) != 1 {
		t.Fatalf("after crash-at-begin attempts = %d, want exactly 1 open", len(it.Attempts))
	}
	open := it.Attempts[0]
	if open.TransportClass != "" || open.EndedAt != 0 {
		t.Fatalf("pre-POST crash left a closed attempt: %+v (must be open: empty class, no end)", open)
	}
	if open.Generation != tok2.Generation() || open.StartedAt == 0 {
		t.Fatalf("open attempt = %+v, want generation %d + non-zero StartedAt", open, tok2.Generation())
	}
	if it.OpencodeMsgID != mintedID {
		t.Fatalf("correlation id changed across crash: %q then %q", mintedID, it.OpencodeMsgID)
	}

	// --- CRASH AFTER POST, BEFORE RECEIPT — through the real executor: the
	// poster itself performs the takeover (release + reacquire bumps the
	// generation mid-POST), so the executor's receipt write is fenced — the
	// deterministic equivalent of the writer dying with the POST complete.
	tok3, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	s3 := &sessionQueueStore{path: path}
	if _, err := s3.Enqueue("receipt-loss", nil, QueueSendConfig{}, ""); err != nil {
		t.Fatal(err)
	}
	var usurper *QueueCustody
	outcome, err := RunQueuedDispatchAttempt(context.Background(), s3, "s1", tok3, func(_ context.Context, _ string, body json.RawMessage) error {
		var b struct {
			MessageID string `json:"messageID"`
		}
		if err := json.Unmarshal(body, &b); err != nil {
			t.Fatalf("poster body: %v", err)
		}
		if b.MessageID == "" {
			t.Fatal("poster body carries no messageID — claim-mint correlation broken")
		}
		// Takeover mid-POST: release, then a NEW owner acquires (gen bump).
		tok3.Release()
		u, uerr := AcquireQueueCustody(root)
		if uerr != nil {
			t.Fatalf("usurper acquire: %v", uerr)
		}
		usurper = u
		return nil // the POST itself completed (204)
	})
	if !errors.Is(err, errQueueFenced) {
		t.Fatalf("receipt after mid-POST takeover err = %v, want errQueueFenced (the crash-at-receipt window)", err)
	}
	if outcome.ItemID == "" || outcome.AttemptIdx != 0 || outcome.Class != "" {
		t.Fatalf("fenced outcome = %+v, want item + attempt 0 + unclassified", outcome)
	}
	if usurper == nil {
		t.Fatal("usurper never took over")
	}

	// Durable state after the receipt-loss crash: the receipt-loss item holds
	// EXACTLY the one OPEN attempt its Begin write journaled — the POST is
	// unprovable from the journal (by design), and the crash-probe item is
	// untouched by the usurper.
	rl := journalItemByText(t, s3, "receipt-loss")
	if rl.State != QueueDispatching || len(rl.Attempts) != 1 || rl.Attempts[0].TransportClass != "" || rl.Attempts[0].EndedAt != 0 {
		t.Fatalf("after crash-at-receipt item = %+v, want dispatching + exactly one OPEN attempt", rl)
	}
	it = journalItemByText(t, s3, "crash-probe")
	if len(it.Attempts) != 1 || it.Attempts[0].TransportClass != "" {
		t.Fatalf("crash-probe journal disturbed by the takeover: %+v", it.Attempts)
	}

	// --- NO-CRASH CONTRAST: a new owner completes a full attempt and the
	// receipt IS durable ---
	usurper.Release()
	tok4, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	defer tok4.Release()
	s4 := &sessionQueueStore{path: path}
	if _, err := s4.Enqueue("completes", nil, QueueSendConfig{}, ""); err != nil {
		t.Fatal(err)
	}
	outcome, err = RunQueuedDispatchAttempt(context.Background(), s4, "s1", tok4, func(context.Context, string, json.RawMessage) error {
		return nil // 204
	})
	if err != nil {
		t.Fatalf("full attempt: %v", err)
	}
	if outcome.Class != QueueAttemptAccepted2xx {
		t.Fatalf("outcome class = %s, want accepted_2xx", outcome.Class)
	}
	done := journalItemByText(t, s4, "completes")
	if len(done.Attempts) != 1 || done.Attempts[0].TransportClass != QueueAttemptAccepted2xx || done.Attempts[0].EndedAt == 0 {
		t.Fatalf("completed attempt journal = %+v, want closed accepted_2xx with EndedAt", done.Attempts)
	}
}

// TestQueueDrainClassifyTransport pins the four transport classes to their
// error shapes — the receipt vocabulary every downstream classifier (2b
// certified classes) depends on.
func TestQueueDrainClassifyTransport(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want QueueAttemptTransportClass
	}{
		{"2xx", nil, QueueAttemptAccepted2xx},
		{"server status", &opencode.Error{Status: 500, Op: "POST /session/s1/prompt_async", Body: "boom"}, QueueAttemptServerError},
		{"dial refused", &net.OpError{Op: "dial", Net: "tcp", Err: os.ErrDeadlineExceeded}, QueueAttemptConnectFailed},
		{"dial refused (url-wrapped)", &url.Error{Op: "Post", URL: "http://127.0.0.1:1/prompt", Err: &net.OpError{Op: "dial", Net: "tcp", Err: io.EOF}}, QueueAttemptConnectFailed},
		{"eof after send", io.ErrUnexpectedEOF, QueueAttemptWrittenUnknown},
		{"read timeout", &net.OpError{Op: "read", Net: "tcp", Err: os.ErrDeadlineExceeded}, QueueAttemptWrittenUnknown},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, _ := classifyTransport(tc.err)
			if got != tc.want {
				t.Fatalf("classifyTransport(%v) = %s, want %s", tc.err, got, tc.want)
			}
		})
	}
}

// TestQueueDrainExecutorRecordsReceipts walks the full executor against a
// failing poster and asserts the durable journal records the receipt EXACTLY
// once per attempt, rejects a double receipt, appends a fresh attempt per
// dispatch, and — the 2a contract — takes NO post-receipt action (item stays
// dispatching; no redelivery, no auto-resolve).
func TestQueueDrainExecutorRecordsReceipts(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	root := custodyTestRoot(t)
	s := &sessionQueueStore{path: queuePath(root, "s1")}
	tok, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	defer tok.Release()

	mustEnqueue(t, s, "receipt-probe")
	outcome, err := RunQueuedDispatchAttempt(context.Background(), s, "s1", tok, func(context.Context, string, json.RawMessage) error {
		return &opencode.Error{Status: 503, Op: "prompt_async", Body: "overloaded"}
	})
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Class != QueueAttemptServerError {
		t.Fatalf("class = %s, want server_error", outcome.Class)
	}

	it := journalItemByText(t, s, "receipt-probe")
	if it.State != QueueDispatching {
		t.Fatalf("post-receipt state = %s, want dispatching (2a records receipts only — no auto-action)", it.State)
	}
	if len(it.Attempts) != 1 {
		t.Fatalf("attempts = %d, want 1", len(it.Attempts))
	}
	a := it.Attempts[0]
	if a.TransportClass != QueueAttemptServerError || a.EndedAt == 0 || a.Generation != tok.Generation() || a.Detail == "" {
		t.Fatalf("receipt = %+v, want server_error + EndedAt + generation + detail", a)
	}

	// Exactly one receipt per attempt: recording again must be rejected.
	if err := s.RecordAttemptOutcome(tok, it.ID, 0, QueueAttemptAccepted2xx, "dup"); err == nil {
		t.Fatal("double receipt accepted — an attempt journals exactly one outcome")
	}

	// A SECOND dispatch attempt on the same item appends a NEW attempt
	// (index 1) — the journal is an append-only history.
	idx, err := s.BeginDispatchAttempt(tok, it.ID)
	if err != nil {
		t.Fatal(err)
	}
	if idx != 1 {
		t.Fatalf("second attempt idx = %d, want 1 (append-only journal)", idx)
	}
	if err := s.RecordAttemptOutcome(tok, it.ID, idx, QueueAttemptConnectFailed, "dial refused"); err != nil {
		t.Fatal(err)
	}
	it = journalItemByText(t, s, "receipt-probe")
	if len(it.Attempts) != 2 || it.Attempts[1].TransportClass != QueueAttemptConnectFailed {
		t.Fatalf("journal after two attempts = %+v", it.Attempts)
	}
}

// TestQueueDrainFlagOffByteEquivalence pins the slice-2a OFF posture: with
// the capability disabled (the production default), the LEGACY path's
// durable artifacts carry NO custody fields and NO custody files exist.
func TestQueueDrainFlagOffByteEquivalence(t *testing.T) {
	root := t.TempDir() // NOTE: custody NOT enabled — production default
	s := &sessionQueueStore{path: queuePath(root, "s1")}

	if _, err := s.Enqueue("legacy", nil, QueueSendConfig{}, ""); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Claim(); err != nil {
		t.Fatal(err)
	}
	items, err := s.List()
	if err != nil || len(items) == 0 {
		t.Fatalf("List: err=%v n=%d", err, len(items))
	}
	if _, err := s.Resolve(items[0].ID, QueueSent, "test"); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(queuePath(root, "s1"))
	if err != nil {
		t.Fatal(err)
	}
	str := string(data)
	for _, forbidden := range []string{"fenceGeneration", `"attempts"`, `"generation"`} {
		if strings.Contains(str, forbidden) {
			t.Fatalf("flag-off queue.json contains %q — the legacy path must stay byte-equivalent: %s", forbidden, data)
		}
	}
	// No custody artifacts anywhere under the project root.
	for _, name := range []string{custodyLockFileRel, custodyGenFileRel} {
		if _, err := os.Stat(filepath.Join(root, ".vh-solara", name)); !os.IsNotExist(err) {
			t.Fatalf("custody artifact %s exists with the flag off (%v)", name, err)
		}
	}
	// And the custody path itself refuses: no generation, no lock.
	if _, err := AcquireQueueCustody(root); !errors.Is(err, errQueueCustodyDisabled) {
		t.Fatalf("flag-off acquire err = %v, want errQueueCustodyDisabled", err)
	}
}
