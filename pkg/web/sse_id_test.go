package web

import "testing"

// TestParseResumeCursor covers the O3 backward-compat parse of the Last-Event-ID
// header: the server must accept BOTH the new compound form ("globalSeq.ordinal")
// and the legacy plain-numeric form, extracting the global seq for store.Replay
// in both cases. The ordinal component is connection-local and is discarded.
func TestParseResumeCursor(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantSeq uint64
		wantOK  bool
	}{
		// Compound form (O3): "globalSeq.ordinal" → extract globalSeq.
		{"compound basic", "42.7", 42, true},
		{"compound zero ordinal", "100.0", 100, true},
		{"compound zero seq", "0.5", 0, true},
		{"compound large seq", "18446744073709551615.99", 18446744073709551615, true},

		// Legacy numeric form: a plain number → the whole value is the global seq.
		{"legacy numeric", "42", 42, true},
		{"legacy zero", "0", 0, true},
		{"legacy large", "18446744073709551615", 18446744073709551615, true},

		// Edge cases.
		{"empty", "", 0, false},
		{"non-numeric", "abc", 0, false},
		{"compound non-numeric seq", "abc.5", 0, false},
		{"trailing dot", "42.", 42, true}, // empty ordinal after dot → seq still 42
		{"multiple dots", "42.7.3", 42, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			seq, ok := parseResumeCursor(tt.input)
			if ok != tt.wantOK {
				t.Fatalf("parseResumeCursor(%q): ok=%v, want %v", tt.input, ok, tt.wantOK)
			}
			if seq != tt.wantSeq {
				t.Errorf("parseResumeCursor(%q): seq=%d, want %d", tt.input, seq, tt.wantSeq)
			}
		})
	}
}

// TestCompoundSSEID_Format verifies the compound SSE id encoding round-trips
// through parseResumeCursor (global seq component).
func TestCompoundSSEID_Format(t *testing.T) {
	tests := []struct {
		seq     uint64
		ordinal uint64
		want    string
	}{
		{0, 0, "0.0"},
		{42, 7, "42.7"},
		{100, 0, "100.0"},
		{18446744073709551615, 99, "18446744073709551615.99"},
	}
	for _, tt := range tests {
		got := compoundSSEID(tt.seq, tt.ordinal)
		if got != tt.want {
			t.Errorf("compoundSSEID(%d, %d) = %q, want %q", tt.seq, tt.ordinal, got, tt.want)
		}
		// Round-trip: parseResumeCursor should extract the global seq.
		seq, ok := parseResumeCursor(got)
		if !ok {
			t.Fatalf("round-trip parseResumeCursor(%q): ok=false", got)
		}
		if seq != tt.seq {
			t.Errorf("round-trip parseResumeCursor(%q): seq=%d, want %d", got, seq, tt.seq)
		}
	}
}
