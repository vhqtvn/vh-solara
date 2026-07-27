package quota

import (
	"encoding/json"
	"testing"
)

// TestReportJSONRoundTrip verifies the provider-neutral DTOs marshal/unmarshal
// through their documented JSON tags. It guards the extraction: a tag rename or
// a dropped omitempty during the split would surface here.
func TestReportJSONRoundTrip(t *testing.T) {
	used := 55.0
	remaining := 45.0
	winSec := int64(18000)
	resetAfter := int64(17000)
	resetAt := int64(1_700_000_000_000)
	in := Report{
		Providers: []ProviderResult{
			{
				ProviderID:   "claude",
				ProviderName: "Claude",
				OK:           true,
				Configured:   true,
				Windows: []UsageWindow{
					{
						Label:             "5h",
						UsedPercent:       &used,
						RemainingPercent:  &remaining,
						WindowSeconds:     &winSec,
						ResetAfterSeconds: &resetAfter,
						ResetAt:           &resetAt,
						ValueLabel:        "$5 remaining",
					},
					{
						// ValueLabel empty -> must be omitted by json tag.
						Label: "credits",
					},
				},
				FetchedAt: 1_700_000_000_000,
			},
			{
				// Error empty -> must be omitted; OK=false surfaces as "ok":false.
				ProviderID:   "openrouter",
				ProviderName: "OpenRouter",
				OK:           false,
				Configured:   false,
				FetchedAt:    1_700_000_000_001,
			},
		},
		FetchedAt: 1_700_000_000_999,
	}

	raw, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	// Spot-check the wire tags directly so a tag drift is unambiguous.
	s := string(raw)
	for _, want := range []string{
		`"providers"`, `"providerId":"claude"`, `"providerName":"Claude"`,
		`"ok":true`, `"configured":true`,
		`"label":"5h"`, `"usedPercent":55`, `"remainingPercent":45`,
		`"windowSeconds":18000`, `"resetAfterSeconds":17000`, `"resetAt":1700000000000`,
		`"valueLabel":"$5 remaining"`, `"fetchedAt"`,
	} {
		if !contains(s, want) {
			t.Errorf("wire JSON missing %q\nfull: %s", want, s)
		}
	}
	// omitempty contracts: a window with empty ValueLabel omits the field.
	if contains(s, `"valueLabel":""`) {
		t.Errorf("ValueLabel should be omitted when empty\nfull: %s", s)
	}
	// Error omitempty: openrouter has no error string.
	if contains(s, `"error"`) {
		t.Errorf("error should be omitted when empty\nfull: %s", s)
	}

	// Round-trip back and assert the pointer fields survive.
	var out Report
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if len(out.Providers) != 2 {
		t.Fatalf("round-trip providers = %d, want 2", len(out.Providers))
	}
	w0 := out.Providers[0].Windows[0]
	if w0.UsedPercent == nil || *w0.UsedPercent != 55 {
		t.Errorf("round-trip UsedPercent lost: %+v", w0)
	}
	if w0.WindowSeconds == nil || *w0.WindowSeconds != 18000 {
		t.Errorf("round-trip WindowSeconds lost: %+v", w0)
	}
	if w0.ValueLabel != "$5 remaining" {
		t.Errorf("round-trip ValueLabel lost: %+v", w0)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}
