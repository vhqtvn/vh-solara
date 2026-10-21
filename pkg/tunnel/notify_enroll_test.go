package tunnel

// notify_enroll_test.go — lane-1 tests for the additive notify capability
// enrollment block (notify controller-hub S2 / v4 §2 step 2): the structural
// Validate floor (the controller records only passing blocks — a malformed
// capability must fail to enroll, never take the tunnel down) and the wire
// shape (nil block = the pre-S2 registration every controller accepts).

import (
	"encoding/json"
	"strings"
	"testing"
)

// validEnrollment is the canonical good block: 64-hex token, cap 1, both
// identity fields, a vocabulary mode.
func validEnrollment() *NotifyEnrollment {
	wm := int64(42)
	return &NotifyEnrollment{
		SourceID:  "bason",
		Epoch:     "0123456789abcdef0123456789abcdef",
		NotifyCap: 1,
		Mode:      "controller",
		Fenced:    true,
		Watermark: &wm,
		Token:     strings.Repeat("a", 64),
	}
}

func TestNotifyEnrollmentValidateAcceptsGoodBlock(t *testing.T) {
	if err := validEnrollment().Validate(); err != nil {
		t.Fatalf("canonical enrollment must validate: %v", err)
	}
	// The standalone posture and the honest-unreadable mode ("") are both
	// recordable — "" reports that ownership state could not be read, never
	// a guess.
	for _, mode := range []string{"", "standalone"} {
		n := validEnrollment()
		n.Mode = mode
		if err := n.Validate(); err != nil {
			t.Fatalf("mode %q must validate: %v", mode, err)
		}
	}
	// nil Watermark (the pre-transfer state) is recordable.
	n := validEnrollment()
	n.Watermark = nil
	if err := n.Validate(); err != nil {
		t.Fatalf("nil watermark must validate: %v", err)
	}
}

func TestNotifyEnrollmentValidateRejectsMalformed(t *testing.T) {
	cases := []struct {
		name string
		mut  func(*NotifyEnrollment)
		want string
	}{
		{"empty source_id", func(n *NotifyEnrollment) { n.SourceID = "" }, "empty source_id"},
		{"empty epoch", func(n *NotifyEnrollment) { n.Epoch = "" }, "empty epoch"},
		{"cap zero", func(n *NotifyEnrollment) { n.NotifyCap = 0 }, "notify_cap"},
		{"cap negative", func(n *NotifyEnrollment) { n.NotifyCap = -1 }, "notify_cap"},
		{"empty token", func(n *NotifyEnrollment) { n.Token = "" }, "empty token"},
		{"token too short", func(n *NotifyEnrollment) { n.Token = strings.Repeat("a", 15) }, "length"},
		{"token too long", func(n *NotifyEnrollment) { n.Token = strings.Repeat("a", 129) }, "length"},
		{"token with space", func(n *NotifyEnrollment) { n.Token = strings.Repeat("a", 15) + " " + strings.Repeat("a", 15) }, "header-unsafe"},
		{"token with CR", func(n *NotifyEnrollment) { n.Token = strings.Repeat("a", 31) + "\r" + strings.Repeat("a", 31) }, "header-unsafe"},
		{"token with LF", func(n *NotifyEnrollment) { n.Token = strings.Repeat("a", 31) + "\n" + strings.Repeat("a", 31) }, "header-unsafe"},
		{"token with control byte", func(n *NotifyEnrollment) { n.Token = strings.Repeat("a", 20) + "\x01" + strings.Repeat("a", 20) }, "header-unsafe"},
		{"token with quote", func(n *NotifyEnrollment) { n.Token = strings.Repeat("a", 20) + `"` + strings.Repeat("a", 20) }, "header-unsafe"},
		{"token with non-ASCII", func(n *NotifyEnrollment) { n.Token = strings.Repeat("a", 20) + "é" + strings.Repeat("a", 20) }, "header-unsafe"},
		{"unknown mode", func(n *NotifyEnrollment) { n.Mode = "hungry" }, "mode"},
	}
	for _, tc := range cases {
		n := validEnrollment()
		tc.mut(n)
		err := n.Validate()
		if err == nil {
			t.Fatalf("%s: must be rejected", tc.name)
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: error %q must name %q", tc.name, err.Error(), tc.want)
		}
	}
	// A nil block answers the dedicated nil error (the caller distinguishes
	// "no capability" from "bad capability" by the nil pointer, not this
	// error, but the guard must exist for misuse).
	var nilBlock *NotifyEnrollment
	if err := nilBlock.Validate(); err == nil || !strings.Contains(err.Error(), "nil") {
		t.Fatalf("nil block must answer the nil error, got %v", err)
	}
}

func TestRegisterMessageNotifyWireShape(t *testing.T) {
	// The pre-S2 shape: no notify block → the field is ABSENT on the wire
	// (omitempty), so an old controller's decoder never sees it and an old
	// worker's registration is byte-compatible with what it always sent.
	reg := RegisterMessage{}
	reg.Type = TypeRegister
	reg.WorkerID = "w1"
	b, err := json.Marshal(reg)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "notify") {
		t.Fatalf("nil block must be wire-absent, got %s", b)
	}
	var back RegisterMessage
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if back.Notify != nil {
		t.Fatal("round-trip of an absent block must stay nil (notify-ineligible)")
	}

	// The S2 shape decodes symmetrically.
	reg.Notify = validEnrollment()
	b, err = json.Marshal(reg)
	if err != nil {
		t.Fatal(err)
	}
	back = RegisterMessage{}
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if back.Notify == nil {
		t.Fatal("present block must round-trip")
	}
	if back.Notify.SourceID != "bason" || back.Notify.Epoch != "0123456789abcdef0123456789abcdef" ||
		back.Notify.NotifyCap != 1 || back.Notify.Token != strings.Repeat("a", 64) {
		t.Fatalf("round-tripped block mismatch: %+v", back.Notify)
	}
	if back.Notify.Watermark == nil || *back.Notify.Watermark != 42 {
		t.Fatalf("watermark must round-trip, got %+v", back.Notify.Watermark)
	}
}
