package quota

import (
	"context"
	"encoding/json"
	"time"
)

func fetchCopilotUser(ctx context.Context, token string) (map[string]any, error) {
	payload, _, err := getJSON(ctx, "https://api.github.com/copilot_internal/user", map[string]string{
		"Authorization":        "token " + token, // GitHub uses `token`, not `Bearer`
		"Accept":               "application/json",
		"Editor-Version":       "vscode/1.96.2",
		"X-Github-Api-Version": "2025-04-01",
	})
	return payload, err
}

// fetchCopilot reads GitHub Copilot chat/completions/premium windows.
func fetchCopilot(ctx context.Context, auth map[string]json.RawMessage) ProviderResult {
	res := ProviderResult{ProviderID: "github-copilot", ProviderName: "GitHub Copilot", FetchedAt: time.Now().UnixMilli()}
	e := entry(auth, "github-copilot", "copilot")
	token := str(e, "access", "token")
	if token == "" {
		res.Error = "Not configured"
		return res
	}
	res.Configured = true
	payload, err := fetchCopilotUser(ctx, token)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	res.Windows = buildCopilotWindows(payload)
	res.OK = true
	return res
}

// fetchCopilotAddon reports only the Copilot premium-interactions window.
func fetchCopilotAddon(ctx context.Context, auth map[string]json.RawMessage) ProviderResult {
	res := ProviderResult{ProviderID: "github-copilot-addon", ProviderName: "GitHub Copilot Add-on", FetchedAt: time.Now().UnixMilli()}
	e := entry(auth, "github-copilot", "copilot")
	token := str(e, "access", "token")
	if token == "" {
		res.Error = "Not configured"
		return res
	}
	res.Configured = true
	payload, err := fetchCopilotUser(ctx, token)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	windows := buildCopilotWindows(payload)
	for _, w := range windows {
		if w.Label == "premium" {
			res.Windows = []UsageWindow{w}
			break
		}
	}
	if res.Windows == nil {
		res.Windows = windows
	}
	res.OK = true
	return res
}
