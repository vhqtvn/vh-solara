package fixtures

// Tests for the OpenCode message-id contract the queue reconciler (Slice 6)
// depends on:
//
//   - caller-id-wins: POST /session/:sid/prompt_async with a body.messageID
//     persists the user message under that EXACT id (both CommitThenDropResponse
//     and Normal modes); an empty/absent messageID falls back to the fake's own
//     u%n id.
//   - exact-GET: GET /session/:sid/message/:mid returns 200 {info,parts} iff
//     the composite (sid, mid) matches a persisted USER message, else 404; a
//     non-msg_-prefixed id → 400.
//
// These close the Slice-5 DEFER F2 (fixture caller-id-wins honoring had no
// unit test and go test ./pkg/fixtures/ was not in the Slice-5 validation run).

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// startFixtureHTTP stands up the fake on an httptest server. Returns the server
// and a cleanup.
func startFixtureHTTP(t *testing.T, f *FakeOpenCode) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(f.Handler())
	t.Cleanup(srv.Close)
	return srv
}

func postJSON(t *testing.T, srv *httptest.Server, path, body string) (*http.Response, []byte) {
	t.Helper()
	resp, err := srv.Client().Post(srv.URL+path, "application/json", strings.NewReader(body))
	// The CommitThenDropResponse mode hijacks+closes the connection, so the
	// client observes a transport error (EOF / connection reset) — that is the
	// modeled "response lost" outcome. Surface it as a synthetic 502 so the
	// caller can proceed to verify the commit happened via a GET.
	if err != nil {
		return &http.Response{StatusCode: http.StatusBadGateway}, nil
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

func get(t *testing.T, srv *httptest.Server, path string) (*http.Response, []byte) {
	t.Helper()
	resp, err := srv.Client().Get(srv.URL + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

// TestPromptAsyncCallerIDWins_CommitThenDropResponse verifies that in the
// ambiguous-receipt mode the user message is committed under the caller-supplied
// EXACT id, so a later exact-GET finds it (the reconciler's authority).
func TestPromptAsyncCallerIDWins_CommitThenDropResponse(t *testing.T) {
	f := New()
	f.SetPromptAsyncMode(PromptAsyncCommitThenDropResponse)
	srv := startFixtureHTTP(t, f)

	const sid = "rcov-1" // unseeded session so the commit count is exactly 1
	const mid = "msg_testcallerid001"
	body := `{"parts":[{"type":"text","text":"hello"}],"messageID":` + jsonQuote(mid) + `}`
	resp, _ := postJSON(t, srv, "/session/"+sid+"/prompt_async", body)
	if resp.StatusCode != http.StatusBadGateway {
		// Response was intentionally dropped (the modeled "lost" outcome).
		t.Fatalf("commit-then-drop: want ~502 (dropped), got %d", resp.StatusCode)
	}
	if f.UserMessageCount(sid) != 1 {
		t.Fatalf("UserMessageCount: got %d want 1 (committed despite dropped response)", f.UserMessageCount(sid))
	}

	// Exact-GET finds the persisted user message under the caller's id.
	gr, gb := get(t, srv, "/session/"+sid+"/message/"+mid)
	if gr.StatusCode != http.StatusOK {
		t.Fatalf("exact-GET: got %d want 200 (body=%s)", gr.StatusCode, gb)
	}
	var got struct {
		Info struct {
			ID   string `json:"id"`
			Role string `json:"role"`
		} `json:"info"`
	}
	if err := json.Unmarshal(gb, &got); err != nil {
		t.Fatalf("unmarshal: %v (body=%s)", err, gb)
	}
	if got.Info.ID != mid || got.Info.Role != "user" {
		t.Fatalf("caller-id-wins: got info{ID:%q Role:%q} want {ID:%q Role:user}", got.Info.ID, got.Info.Role, mid)
	}
}

// TestPromptAsyncCallerIDWins_Normal verifies the faithful path also persists
// the caller-supplied exact id (caller-id-wins holds in every mode).
func TestPromptAsyncCallerIDWins_Normal(t *testing.T) {
	f := New()
	f.SetPromptAsyncMode(PromptAsyncNormal)
	srv := startFixtureHTTP(t, f)

	const sid = "rcov-2"
	const mid = "msg_normalcallerid002"
	body := `{"parts":[{"type":"text","text":"hi"}],"messageID":` + jsonQuote(mid) + `}`
	resp, _ := postJSON(t, srv, "/session/"+sid+"/prompt_async", body)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("normal: got %d want 204", resp.StatusCode)
	}
	gr, _ := get(t, srv, "/session/"+sid+"/message/"+mid)
	if gr.StatusCode != http.StatusOK {
		t.Fatalf("exact-GET (normal): got %d want 200", gr.StatusCode)
	}
}

// TestPromptAsyncEmptyMessageIDFallsBack verifies an absent/empty messageID
// makes the fake mint its own u%n id (the pre-Slice-5 path), and that a
// caller-supplied msg_ id does NOT collide with it.
func TestPromptAsyncEmptyMessageIDFallsBack(t *testing.T) {
	f := New()
	f.SetPromptAsyncMode(PromptAsyncCommitThenDropResponse)
	srv := startFixtureHTTP(t, f)

	const sid = "rcov-3"
	// No messageID field at all.
	postJSON(t, srv, "/session/"+sid+"/prompt_async", `{"parts":[{"type":"text","text":"fallback"}]}`)
	if f.UserMessageCount(sid) != 1 {
		t.Fatalf("UserMessageCount: got %d want 1", f.UserMessageCount(sid))
	}
	// A GET for any msg_-prefixed id must 404 (the fake minted a u%n id).
	gr, _ := get(t, srv, "/session/"+sid+"/message/msg_neverminted003")
	if gr.StatusCode != http.StatusNotFound {
		t.Fatalf("empty-messageID fallback: got %d want 404", gr.StatusCode)
	}
}

// TestExactGET_NotFoundForWrongID verifies the composite-key miss returns 404
// (a wrong id under the right session is a clean miss).
func TestExactGET_NotFoundForWrongID(t *testing.T) {
	f := New()
	f.SetPromptAsyncMode(PromptAsyncCommitThenDropResponse)
	srv := startFixtureHTTP(t, f)

	const sid = "rcov-4"
	const mid = "msg_realid004"
	postJSON(t, srv, "/session/"+sid+"/prompt_async", `{"parts":[{"type":"text","text":"x"}],"messageID":`+jsonQuote(mid)+`}`)

	// A different msg_ id under the same session → 404.
	gr, _ := get(t, srv, "/session/"+sid+"/message/msg_differentid005")
	if gr.StatusCode != http.StatusNotFound {
		t.Fatalf("wrong id: got %d want 404", gr.StatusCode)
	}
}

// TestExactGET_NotFoundForWrongSession verifies session isolation: a message
// committed under one session is NOT visible under another session's path even
// with the same id.
func TestExactGET_NotFoundForWrongSession(t *testing.T) {
	f := New()
	f.SetPromptAsyncMode(PromptAsyncCommitThenDropResponse)
	srv := startFixtureHTTP(t, f)

	const mid = "msg_sesiso006"
	postJSON(t, srv, "/session/rcov-5a/prompt_async", `{"parts":[{"type":"text","text":"x"}],"messageID":`+jsonQuote(mid)+`}`)
	// Committed under rcov-5a; a GET under rcov-5b must 404 (composite key).
	gr, _ := get(t, srv, "/session/rcov-5b/message/"+mid)
	if gr.StatusCode != http.StatusNotFound {
		t.Fatalf("wrong session: got %d want 404", gr.StatusCode)
	}
}

// TestExactGET_400ForNonMsgPrefix verifies a non-msg_-prefixed id is rejected
// with 400 (caller bug), matching real OpenCode.
func TestExactGET_400ForNonMsgPrefix(t *testing.T) {
	f := New()
	srv := startFixtureHTTP(t, f)

	gr, _ := get(t, srv, "/session/rcov-6/message/u1")
	if gr.StatusCode != http.StatusBadRequest {
		t.Fatalf("non-msg_ prefix: got %d want 400", gr.StatusCode)
	}
}

// jsonQuote is a tiny helper to embed a Go string as a JSON string literal.
func jsonQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
