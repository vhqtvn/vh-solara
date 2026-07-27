package quota

// UsageWindow is one rate-limit/credit window for a provider.
type UsageWindow struct {
	Label             string   `json:"label"`
	UsedPercent       *float64 `json:"usedPercent"`
	RemainingPercent  *float64 `json:"remainingPercent"`
	WindowSeconds     *int64   `json:"windowSeconds"`
	ResetAfterSeconds *int64   `json:"resetAfterSeconds"`
	ResetAt           *int64   `json:"resetAt"`
	ValueLabel        string   `json:"valueLabel,omitempty"`
}

// ProviderResult is the per-provider quota report.
type ProviderResult struct {
	ProviderID   string        `json:"providerId"`
	ProviderName string        `json:"providerName"`
	OK           bool          `json:"ok"`
	Configured   bool          `json:"configured"`
	Windows      []UsageWindow `json:"windows"`
	Error        string        `json:"error,omitempty"`
	FetchedAt    int64         `json:"fetchedAt"`
}

// Report is the full multi-provider response.
type Report struct {
	Providers []ProviderResult `json:"providers"`
	FetchedAt int64            `json:"fetchedAt"`
}
