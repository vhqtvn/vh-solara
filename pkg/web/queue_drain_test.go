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
	if _, err := s2.BeginDispatchAttempt(tok2, it.ID, 0); err != nil {
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
	outcome, err := RunQueuedDispatchAttempt(context.Background(), s3, "s1", tok3, 0, func(_ context.Context, _ string, body json.RawMessage) error {
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
	outcome, err = RunQueuedDispatchAttempt(context.Background(), s4, "s1", tok4, 0, func(context.Context, string, json.RawMessage) error {
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
	outcome, err := RunQueuedDispatchAttempt(context.Background(), s, "s1", tok, 0, func(context.Context, string, json.RawMessage) error {
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
	idx, err := s.BeginDispatchAttempt(tok, it.ID, 0)
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

// --- T1C-F1: the pre-POST fence branch (red-signal) ---------------------------
//
// The pre-POST FenceCheck in RunQueuedDispatchAttempt — the compare-and-fence
// immediately before the upstream POST — previously had NO test that fails if
// the branch is deleted: the crash-at-each-transition crux proves the RECEIPT
// fence (mid-POST takeover), but the pre-POST window sits between two store
// calls with no statement boundary a test can interleave at. The
// queueDrainPrePostSeam (nil in production) gives the test exactly that
// window: drive the executor PAST claim/begin with a LIVE token, bump the
// authority out-of-band at the seam, and the pre-POST fence must reject —
// the poster NEVER runs. Deleting the FenceCheck (or the seam firing before
// it) makes this test fail: the poster would be invoked.
func TestQueueDrainPrePostFenceBlocksPoster(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	root := custodyTestRoot(t)
	path := queuePath(root, "prepost")
	tok, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	defer tok.Release()
	s := &sessionQueueStore{path: path}
	if _, err := s.Enqueue("fenced-pre-post", nil, QueueSendConfig{}, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Enqueue("second-pending", nil, QueueSendConfig{}, ""); err != nil {
		t.Fatal(err)
	}

	posterRan := false
	// At the exact pre-POST window (begin durable, POST not yet sent): bump
	// the authority OUT-OF-BAND — the durable record of a newer owner. The
	// token itself stays LIVE (never released), so the fence must reject via
	// the generation-MISMATCH branch, not the revocation branch (G5).
	genPath := filepath.Join(root, ".vh-solara", custodyGenFileRel)
	queueDrainPrePostSeam = func() {
		if err := writeCustodyGeneration(genPath, tok.Generation()+1); err != nil {
			t.Errorf("out-of-band authority bump: %v", err)
		}
	}
	t.Cleanup(func() { queueDrainPrePostSeam = nil })

	outcome, err := RunQueuedDispatchAttempt(context.Background(), s, "prepost", tok, 0, func(context.Context, string, json.RawMessage) error {
		posterRan = true
		return nil
	})
	if !errors.Is(err, errQueueFenced) {
		t.Fatalf("pre-POST fence err = %v, want errQueueFenced", err)
	}
	if !strings.Contains(err.Error(), "newer owner") {
		t.Fatalf("fence error = %q, want the generation-mismatch branch (G5: live token, out-of-band bump)", err.Error())
	}
	if strings.Contains(err.Error(), "released") {
		t.Fatalf("fence error = %q — hit the REVOCATION branch; the token must stay live for the mismatch branch", err.Error())
	}
	if posterRan {
		t.Fatal("poster ran despite a failed pre-POST fence — a stale token reached the network")
	}
	if outcome.ItemID == "" || outcome.AttemptIdx != 0 || outcome.Class != "" {
		t.Fatalf("pre-POST fenced outcome = %+v, want item + attempt 0 + unclassified", outcome)
	}
	// Durable journal: EXACTLY the begin write — one OPEN attempt under the
	// (now stale) generation; no receipt, no poster side effects.
	it := journalItemByText(t, s, "fenced-pre-post")
	if it.State != QueueDispatching || len(it.Attempts) != 1 {
		t.Fatalf("fenced item = %+v, want dispatching with exactly 1 attempt", it)
	}
	if open := it.Attempts[0]; open.TransportClass != "" || open.EndedAt != 0 || open.Generation != tok.Generation() {
		t.Fatalf("pre-POST attempt = %+v, want OPEN under generation %d (empty class, no end)", open, tok.Generation())
	}
	// The second pending item is untouched by the fenced executor.
	second := journalItemByText(t, s, "second-pending")
	if second.State != QueuePending {
		t.Fatalf("second item state = %s, want pending (fenced executor must not disturb it)", second.State)
	}
}

// --- G5: live-token generation mismatch at the fence ---------------------------

// TestQueueCustodyLiveTokenGenerationMismatch covers the FenceCheck branch
// that had NO coverage post-revocation-fix: cur != c.gen with a LIVE
// (unreleased) token. The pre-existing tests always release the token first,
// so the released/revocation branch fires before the authority is even read.
// Here the token stays live for every assertion; the authority is bumped
// out-of-band (the durable record of a newer owner — crash recovery, or
// another machine's acquisition on a shared volume).
func TestQueueCustodyLiveTokenGenerationMismatch(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	root := custodyTestRoot(t)
	tok, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	defer tok.Release() // LIVE for every assertion below — released only at cleanup

	// Out-of-band bump: authority now records a generation NEWER than tok's.
	genPath := filepath.Join(root, ".vh-solara", custodyGenFileRel)
	if err := writeCustodyGeneration(genPath, tok.Generation()+1); err != nil {
		t.Fatal(err)
	}

	// (a) The fence rejects the live-but-stale token via the MISMATCH branch.
	err = tok.FenceCheck()
	if !errors.Is(err, errQueueFenced) {
		t.Fatalf("live-token mismatch FenceCheck err = %v, want errQueueFenced", err)
	}
	if msg := err.Error(); !strings.Contains(msg, "newer owner") || strings.Contains(msg, "released") {
		t.Fatalf("fence error = %q, want the mismatch branch (newer owner), not the revocation branch", msg)
	}

	// (b) The store gates reject it too (claim under a fenced token).
	s := &sessionQueueStore{path: queuePath(root, "g5")}
	mustEnqueue(t, s, "g5-probe")
	if _, _, err := s.ClaimForCustody(tok); !errors.Is(err, errQueueFenced) {
		t.Fatalf("ClaimForCustody under live-stale token err = %v, want errQueueFenced", err)
	}

	// (c) The executor rejects at claim — the poster is never invoked.
	posterRan := false
	_, err = RunQueuedDispatchAttempt(context.Background(), s, "g5", tok, 0, func(context.Context, string, json.RawMessage) error {
		posterRan = true
		return nil
	})
	if !errors.Is(err, errQueueFenced) {
		t.Fatalf("executor under live-stale token err = %v, want errQueueFenced", err)
	}
	if posterRan {
		t.Fatal("poster ran under a live-stale (mismatched) token")
	}
}

// --- C-F3: buildPromptBody mirrors the legacy FE dispatch passthrough ---------
//
// The daemon body builder must stay shape-compatible with what the legacy
// browser dispatch sends today (web/src/components/chat/createSend.ts
// dispatchQueuedItem + buildParts): text part, file parts (minus vh-attach:
// inline chips), agent, the ATOMIC provider/model pair, variant nested in the
// model branch, and the claim-minted messageID.
func TestQueueDrainPromptBodyMirrorsFEDispatch(t *testing.T) {
	// decodeBody gives a FRESH view per call (a reused struct would keep an
	// absent-pointer field from the previous case — json.Unmarshal does not
	// clear what a body omits).
	decodeBody := func(b json.RawMessage) (parts []map[string]string, agent string, model map[string]string, variant, messageID string) {
		var raw struct {
			Parts     []map[string]string `json:"parts"`
			Agent     string              `json:"agent"`
			Model     map[string]string   `json:"model"`
			Variant   string              `json:"variant"`
			MessageID string              `json:"messageID"`
		}
		if err := json.Unmarshal(b, &raw); err != nil {
			t.Fatal(err)
		}
		return raw.Parts, raw.Agent, raw.Model, raw.Variant, raw.MessageID
	}

	// Full propagation: text + real attachment + inline chip + full config.
	item := QueueItem{
		Text: "hello with files",
		Attachments: []QueueAttachment{
			{URL: "file:///tmp/report.pdf", Filename: "report.pdf", Mime: "application/pdf"},
			{URL: "vh-attach:chip-1", Filename: "inline.txt", Mime: "text/plain"}, // synthetic chip — excluded
		},
		SendConfig:    QueueSendConfig{ProviderID: "anthropic", ModelID: "claude-4", Variant: "stable", Agent: "build"},
		OpencodeMsgID: "msg_full",
	}
	parts, agent, model, variant, messageID := decodeBody(buildPromptBody(item))
	if len(parts) != 2 {
		t.Fatalf("parts = %+v, want 2 (text + real file; the vh-attach: chip is excluded)", parts)
	}
	if parts[0]["type"] != "text" || parts[0]["text"] != "hello with files" {
		t.Fatalf("text part = %+v", parts[0])
	}
	filePart := parts[1]
	if filePart["type"] != "file" || filePart["url"] != "file:///tmp/report.pdf" || filePart["filename"] != "report.pdf" || filePart["mime"] != "application/pdf" {
		t.Fatalf("file part = %+v, want the full FE shape (url+filename+mime always present)", filePart)
	}
	if agent != "build" {
		t.Fatalf("agent = %q, want the captured SendConfig.Agent", agent)
	}
	if model == nil || model["providerID"] != "anthropic" || model["modelID"] != "claude-4" {
		t.Fatalf("model = %v, want the atomic provider/model pair", model)
	}
	if variant != "stable" {
		t.Fatalf("variant = %q, want it threaded inside the model branch", variant)
	}
	if messageID != "msg_full" {
		t.Fatalf("messageID = %q, want the item's correlation id", messageID)
	}

	// Empty text: attachments-only item — no text part (FE buildParts guard).
	item = QueueItem{
		Attachments:   []QueueAttachment{{URL: "file:///x.png", Filename: "x.png", Mime: "image/png"}},
		OpencodeMsgID: "msg_attonly",
	}
	parts, _, _, _, _ = decodeBody(buildPromptBody(item))
	if len(parts) != 1 || parts[0]["type"] != "file" {
		t.Fatalf("attachments-only parts = %+v, want exactly the file part", parts)
	}

	// HALF a model config (provider without model): the pair is atomic on the
	// FE — no model key, and therefore no variant either.
	item = QueueItem{
		Text:          "half",
		SendConfig:    QueueSendConfig{ProviderID: "anthropic", Variant: "stable", Agent: "build"},
		OpencodeMsgID: "msg_half",
	}
	_, _, model, variant, _ = decodeBody(buildPromptBody(item))
	if model != nil {
		t.Fatalf("half config produced model = %v — the pair must be atomic", model)
	}
	if variant != "" {
		t.Fatalf("variant = %q outside the model branch — the FE nests it there", variant)
	}

	// Byte-shape legacy compat: a minimal text-only item (the pre-C-F3
	// builder's exact output) must stay byte-identical.
	item = QueueItem{Text: "legacy", OpencodeMsgID: "msg_min"}
	if b := buildPromptBody(item); string(b) != `{"parts":[{"text":"legacy","type":"text"}],"messageID":"msg_min"}` {
		t.Fatalf("minimal body bytes = %s — legacy text-only dispatch must be byte-identical", b)
	}
}

// TestQueueDrainPromptBodyPropagationThroughExecutor proves the WIRING (not
// just the builder): the executor hands the poster a body built from the
// CLAIMED item — captured SendConfig and attachments included, correlation id
// minted at claim.
func TestQueueDrainPromptBodyPropagationThroughExecutor(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	root := custodyTestRoot(t)
	tok, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	defer tok.Release()
	s := &sessionQueueStore{path: queuePath(root, "bodywire")}
	if _, err := s.Enqueue("propagate me", []QueueAttachment{
		{URL: "file:///tmp/a.pdf", Filename: "a.pdf", Mime: "application/pdf"},
		{URL: "vh-attach:chip", Filename: "chip.txt", Mime: "text/plain"},
	}, QueueSendConfig{ProviderID: "p1", ModelID: "m1", Variant: "v1", Agent: "ag1"}, "client-1"); err != nil {
		t.Fatal(err)
	}
	var captured json.RawMessage
	_, err = RunQueuedDispatchAttempt(context.Background(), s, "bodywire", tok, 0, func(_ context.Context, _ string, body json.RawMessage) error {
		captured = append([]byte(nil), body...)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Parts []map[string]string `json:"parts"`
		Agent string              `json:"agent"`
		Model *struct {
			ProviderID string `json:"providerID"`
			ModelID    string `json:"modelID"`
		} `json:"model"`
		Variant   string `json:"variant"`
		MessageID string `json:"messageID"`
	}
	if err := json.Unmarshal(captured, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Parts) != 2 || got.Parts[0]["type"] != "text" || got.Parts[1]["url"] != "file:///tmp/a.pdf" {
		t.Fatalf("propagated parts = %+v, want text + real file (chip excluded)", got.Parts)
	}
	if got.Agent != "ag1" || got.Model == nil || got.Model.ProviderID != "p1" || got.Model.ModelID != "m1" || got.Variant != "v1" {
		t.Fatalf("propagated config = agent:%q model:%+v variant:%q — SendConfig must thread through", got.Agent, got.Model, got.Variant)
	}
	if got.MessageID == "" || !strings.HasPrefix(got.MessageID, "msg_") {
		t.Fatalf("propagated messageID = %q, want the claim-minted id", got.MessageID)
	}
}
