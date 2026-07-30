package quota

import "testing"

// TestCodexCreditsWindow covers the four branches of codexCreditsWindow that
// fetchCodex previously inlined: absent credits object, unlimited flag,
// numeric balance, and a credits object with neither field set. The helper
// returns (zero, false) when no window can be derived so the caller skips the
// append — these cases pin that contract.
func TestCodexCreditsWindow(t *testing.T) {
	t.Run("credits absent", func(t *testing.T) {
		w, ok := codexCreditsWindow(map[string]any{})
		if ok {
			t.Fatalf("ok = true, want false (no credits object)")
		}
		if (w != UsageWindow{}) {
			t.Errorf("want zero UsageWindow, got %+v", w)
		}
	})

	t.Run("unlimited true", func(t *testing.T) {
		payload := map[string]any{
			"credits": map[string]any{"unlimited": true},
		}
		w, ok := codexCreditsWindow(payload)
		if !ok {
			t.Fatalf("ok = false, want true")
		}
		if w.Label != "credits" {
			t.Errorf("Label = %q, want %q", w.Label, "credits")
		}
		if w.ValueLabel != "Unlimited" {
			t.Errorf("ValueLabel = %q, want %q", w.ValueLabel, "Unlimited")
		}
		// credits window carries no percent/timing data
		if w.UsedPercent != nil || w.WindowSeconds != nil || w.ResetAt != nil {
			t.Errorf("credits window should not carry percent/timing: %+v", w)
		}
	})

	t.Run("numeric balance", func(t *testing.T) {
		payload := map[string]any{
			"credits": map[string]any{"balance": float64(5.0)},
		}
		w, ok := codexCreditsWindow(payload)
		if !ok {
			t.Fatalf("ok = false, want true")
		}
		if w.Label != "credits" {
			t.Errorf("Label = %q, want %q", w.Label, "credits")
		}
		if w.ValueLabel != "$5.00 remaining" {
			t.Errorf("ValueLabel = %q, want %q", w.ValueLabel, "$5.00 remaining")
		}
	})

	t.Run("credits present but no label derivable", func(t *testing.T) {
		// neither unlimited nor balance -> no label -> ok=false
		payload := map[string]any{
			"credits": map[string]any{"some_other_field": "x"},
		}
		w, ok := codexCreditsWindow(payload)
		if ok {
			t.Fatalf("ok = true, want false (no label derivable)")
		}
		if (w != UsageWindow{}) {
			t.Errorf("want zero UsageWindow, got %+v", w)
		}
	})
}
