package opencode

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// capturePromptServer is an httptest server that records the path + raw body of
// a prompt_async POST and replies 204 (the real prompt_async fork-and-return
// status). It exists to assert what vh-solara actually puts on the wire — the
// load-bearing surface for the #1925 guard.
func capturePromptServer(t *testing.T) (*httptest.Server, *string, *string) {
	t.Helper()
	var gotPath, gotBody string
	mux := http.NewServeMux()
	mux.HandleFunc("/session/", func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusNoContent)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, &gotPath, &gotBody
}

// TestPromptForwardsModelVerbatim is the #1925 regression guard.
//
// Bug-class #1925 (clean-room from the paseo study, AGPL — do NOT copy paseo
// source): a client that resolves an external model identifier against a
// client-side hardcoded default — e.g. forcing providerID "opencode" for any
// model string lacking a "provider/" prefix — breaks models owned by another
// provider (the prefix-less id resolves to the wrong provider; the server
// returns "Model not found"). Durable lesson: never resolve an external
// identifier against a client-side hardcoded default.
//
// vh-solara's outbound dispatch PROXIES THE MODEL FIELD VERBATIM. Prompt takes
// the body as json.RawMessage and forwards the bytes untouched (postRaw wraps
// them in a bytes.Reader — no parsing, no re-serialization). Whatever model
// shape the caller serialized is exactly what the opencode server sees; the
// server is the single authority for provider/model resolution.
//
// This test MUST FAIL if a future change makes Prompt (or postRaw) rewrite the
// model field, split a prefix-less id on "/", re-resolve it, or inject a
// hardcoded providerID such as "opencode". The input is deliberately a
// prefix-less model id owned by a NON-opencode provider — the exact shape the
// bug mis-resolves.
func TestPromptForwardsModelVerbatim(t *testing.T) {
	// Prefix-less model id owned by a non-opencode provider. Under the #1925
	// bug this is the input that gets mis-resolved to providerID "opencode".
	const prefixLessModel = "glm-5.1"
	bodyIn, err := json.Marshal(map[string]any{
		"parts": []map[string]any{{"type": "text", "text": "hi"}},
		"model": prefixLessModel,
	})
	if err != nil {
		t.Fatalf("marshal bodyIn: %v", err)
	}

	srv, gotPath, gotBody := capturePromptServer(t)
	c := New(srv.URL)
	if _, err := c.Prompt(context.Background(), "s1", bodyIn); err != nil {
		t.Fatalf("Prompt: unexpected error: %v", err)
	}

	if want := "/session/s1/prompt_async"; *gotPath != want {
		t.Fatalf("request path: got %q want %q", *gotPath, want)
	}

	// (1) VERBATIM FORWARDING — the strongest guard: the bytes the server
	// received must equal the bytes the caller passed in. ANY rewriting
	// (providerID injection, model-string splitting, re-serialization that
	// drops/reorders/changes a field) breaks this.
	if *gotBody != string(bodyIn) {
		t.Fatalf("Prompt rewrote the body (must forward verbatim):\n got %s\nwant %s", *gotBody, string(bodyIn))
	}

	// (2) NO HARDCODED PROVIDERID — the dispatched body must not carry a
	// synthesized providerID nor a provider-prefixed model. A #1925 regression
	// would inject e.g. providerID "opencode" or rewrite model to
	// "opencode/glm-5.1".
	if strings.Contains(*gotBody, `"opencode"`) {
		t.Fatalf("Prompt must NOT inject a hardcoded providerID \"opencode\" (#1925 regression): %s", *gotBody)
	}
	if strings.Contains(*gotBody, "opencode/"+prefixLessModel) {
		t.Fatalf("Prompt must NOT force a provider prefix onto a prefix-less model id (#1925 regression): %s", *gotBody)
	}

	// (3) MODEL FIELD PRESERVED — the bare model id survives untouched (not
	// dropped, not re-resolved, not re-shaped into {providerID,modelID}).
	var got map[string]any
	if err := json.Unmarshal([]byte(*gotBody), &got); err != nil {
		t.Fatalf("dispatched body is not valid JSON: %v\n%s", err, *gotBody)
	}
	m, ok := got["model"]
	if !ok {
		t.Fatalf("model field dropped from dispatched body: %s", *gotBody)
	}
	if ms, ok := m.(string); !ok || ms != prefixLessModel {
		t.Fatalf("model field rewritten: got %v want %q (#1925: must forward verbatim)", m, prefixLessModel)
	}
}

// TestPromptForwardsAbsentModelUnchanged pins the other half of the #1925
// philosophy: when the caller sends NO model field, Prompt must NOT invent one
// (no providerID, no model, no defaulting). The opencode server owns the
// default; vh-solara forwards exactly what it was given.
func TestPromptForwardsAbsentModelUnchanged(t *testing.T) {
	// No model field at all.
	bodyIn := []byte(`{"parts":[{"type":"text","text":"hi"}]}`)

	srv, _, gotBody := capturePromptServer(t)
	c := New(srv.URL)
	if _, err := c.Prompt(context.Background(), "s1", bodyIn); err != nil {
		t.Fatalf("Prompt: unexpected error: %v", err)
	}

	// Verbatim: absent model stays absent (no injection).
	if *gotBody != string(bodyIn) {
		t.Fatalf("Prompt rewrote the body (must forward verbatim):\n got %s\nwant %s", *gotBody, string(bodyIn))
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(*gotBody), &got); err != nil {
		t.Fatalf("dispatched body is not valid JSON: %v\n%s", err, *gotBody)
	}
	if _, present := got["model"]; present {
		t.Fatalf("Prompt injected a model field the caller never sent (#1925 regression): %s", *gotBody)
	}
	if _, present := got["providerID"]; present {
		t.Fatalf("Prompt injected a providerID field the caller never sent (#1925 regression): %s", *gotBody)
	}
}
