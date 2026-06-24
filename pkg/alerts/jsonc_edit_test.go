package alerts

import (
	"encoding/json"
	"strings"
	"testing"
)

// applyTo is a small helper: marshal a Config, apply it surgically to src.
func applyTo(t *testing.T, src string, cfg Config) string {
	t.Helper()
	b, _ := json.Marshal(cfg)
	var nv map[string]any
	if err := json.Unmarshal(b, &nv); err != nil {
		t.Fatal(err)
	}
	out, err := editJSONC([]byte(src), nv, topOrder)
	if err != nil {
		t.Fatalf("editJSONC: %v", err)
	}
	// The result must be valid JSON after comment-stripping.
	var check Config
	if err := json.Unmarshal(stripJSONC(out), &check); err != nil {
		t.Fatalf("result not valid JSONC: %v\n%s", err, out)
	}
	return string(out)
}

func TestSurgicalEditKeepsComments(t *testing.T) {
	src := `// vh-solara alerts — hand edited, keep my notes!
{
  // detection knobs
  "detect": {
    "finished_settle_sec": 5,
    "think_sec": 300, // GLM loop guard
    "command_sec": 300,
    "stalled_sec": 180,
    "cooldown_sec": 300,
    "idle_sec": 120
  },
  "active_profile": "At desk",
  "my_custom_key": { "keep": true }, // unknown key must survive
  "profiles": [],
  "channels": []
}
`
	var cfg Config
	if err := json.Unmarshal(stripJSONC([]byte(src)), &cfg); err != nil {
		t.Fatal(err)
	}
	// Change two scalars only.
	cfg.Active = "Away"
	cfg.Detect.ThinkSec = 600

	out := applyTo(t, src, cfg)

	for _, want := range []string{
		"// vh-solara alerts — hand edited, keep my notes!",
		"// detection knobs",
		"// GLM loop guard",
		"// unknown key must survive",
		`"my_custom_key": { "keep": true }`,
		`"active_profile": "Away"`,
		`"think_sec": 600`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	// Untouched scalars must be byte-identical (not reformatted).
	if !strings.Contains(out, `"finished_settle_sec": 5`) {
		t.Errorf("untouched value reformatted:\n%s", out)
	}
}

func TestSurgicalEditChangesArrayWhole(t *testing.T) {
	src := `{
  "detect": { "finished_settle_sec": 5, "think_sec": 300, "command_sec": 300, "stalled_sec": 180, "cooldown_sec": 300, "idle_sec": 120 },
  "active_profile": "At desk",
  "profiles": [],
  "channels": []
}
`
	var cfg Config
	_ = json.Unmarshal(stripJSONC([]byte(src)), &cfg)
	cfg.Channels = []Channel{{ID: "c1", Type: ChannelWebhook, URL: "https://x", Enabled: true}}
	out := applyTo(t, src, cfg)
	if !strings.Contains(out, `"id": "c1"`) || !strings.Contains(out, `https://x`) {
		t.Errorf("channel not written:\n%s", out)
	}
	// active_profile and detect must be untouched.
	if !strings.Contains(out, `"active_profile": "At desk"`) {
		t.Errorf("unrelated value changed:\n%s", out)
	}
}

func TestSurgicalEditAppendsMissingKey(t *testing.T) {
	// A hand-written file with no "detect" block — save must append it.
	src := `{
  "active_profile": "At desk",
  "profiles": [],
  "channels": []
}
`
	var cfg Config
	_ = json.Unmarshal(stripJSONC([]byte(src)), &cfg)
	cfg.Detect = DefaultConfig().Detect
	out := applyTo(t, src, cfg)
	if !strings.Contains(out, `"detect"`) || !strings.Contains(out, `"idle_sec": 120`) {
		t.Errorf("missing key not appended:\n%s", out)
	}
}

func TestNoChangeIsByteIdentical(t *testing.T) {
	src := `{
  // keep everything exactly
  "detect": { "finished_settle_sec": 5, "think_sec": 300, "command_sec": 300, "stalled_sec": 180, "cooldown_sec": 300, "idle_sec": 120 },
  "active_profile": "At desk",
  "profiles": [],
  "channels": []
}`
	var cfg Config
	_ = json.Unmarshal(stripJSONC([]byte(src)), &cfg)
	out := applyTo(t, src, cfg)
	if out != src {
		t.Errorf("no-op edit changed bytes:\nwant:\n%s\ngot:\n%s", src, out)
	}
}
