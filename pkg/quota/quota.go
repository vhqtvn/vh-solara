// Package quota reports provider usage quotas by reading OpenCode's stored
// credentials (auth.json) and calling each provider's own usage endpoint —
// the same mechanism OpenChamber uses. Only providers reachable with the
// stored token/key (no OAuth-refresh dance) are implemented: Claude, Codex
// (ChatGPT), OpenRouter, z.ai coding plan, Zhipu AI coding plan, Kimi for
// Coding, NanoGPT, and GitHub Copilot (+ add-on). Google/Gemini needs an OAuth
// refresh flow and is intentionally omitted.
package quota

import (
	"context"
	"encoding/json"
	"os"
	"sort"
	"sync"
	"time"
)

// configuredProviders detects which providers are present in auth.json.
func configuredProviders(auth map[string]json.RawMessage) []string {
	var ids []string
	if e := entry(auth, "anthropic", "claude"); e != nil && str(e, "access", "token") != "" {
		ids = append(ids, "claude")
	}
	if e := entry(auth, "openai", "codex", "chatgpt"); e != nil && str(e, "access", "token") != "" {
		ids = append(ids, "codex")
	}
	if e := entry(auth, "openrouter"); e != nil && str(e, "key", "token") != "" {
		ids = append(ids, "openrouter")
	}
	if e := entry(auth, "zai-coding-plan", "zai", "z.ai"); e != nil && str(e, "key", "token") != "" {
		ids = append(ids, "zai-coding-plan")
	}
	if e := entry(auth, "zhipuai-coding-plan"); e != nil && str(e, "key", "token") != "" {
		ids = append(ids, "zhipuai-coding-plan")
	}
	if e := entry(auth, "kimi-for-coding", "kimi"); e != nil && str(e, "key", "token") != "" {
		ids = append(ids, "kimi-for-coding")
	}
	if e := entry(auth, "nano-gpt", "nanogpt", "nano_gpt"); e != nil && str(e, "key", "token") != "" {
		ids = append(ids, "nano-gpt")
	}
	if e := entry(auth, "github-copilot", "copilot"); e != nil && str(e, "access", "token") != "" {
		ids = append(ids, "github-copilot", "github-copilot-addon")
	}
	return ids
}

// Fetch reports quotas for all supported, configured providers concurrently.
// If VH_QUOTA_FIXTURE holds JSON, it is returned verbatim (test/demo hook).
func Fetch(ctx context.Context) Report {
	if fx := os.Getenv("VH_QUOTA_FIXTURE"); fx != "" {
		var r Report
		if json.Unmarshal([]byte(fx), &r) == nil {
			r.FetchedAt = time.Now().UnixMilli()
			return r
		}
	}
	auth := readAuth()
	ids := configuredProviders(auth)
	results := make([]ProviderResult, len(ids))
	var wg sync.WaitGroup
	for i, id := range ids {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			switch id {
			case "claude":
				results[i] = fetchClaude(ctx, auth)
			case "codex":
				results[i] = fetchCodex(ctx, auth)
			case "openrouter":
				results[i] = fetchOpenRouter(ctx, auth)
			case "zai-coding-plan":
				results[i] = fetchZai(ctx, auth)
			case "zhipuai-coding-plan":
				results[i] = fetchZhipuai(ctx, auth)
			case "kimi-for-coding":
				results[i] = fetchKimi(ctx, auth)
			case "nano-gpt":
				results[i] = fetchNanoGpt(ctx, auth)
			case "github-copilot":
				results[i] = fetchCopilot(ctx, auth)
			case "github-copilot-addon":
				results[i] = fetchCopilotAddon(ctx, auth)
			}
		}(i, id)
	}
	wg.Wait()
	sort.Slice(results, func(a, b int) bool { return results[a].ProviderName < results[b].ProviderName })
	return Report{Providers: results, FetchedAt: time.Now().UnixMilli()}
}
