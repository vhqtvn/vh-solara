package state

// Standing-check for the validated Store configuration boundary (audit L-15 /
// remediation M6). Every tunable must be represented in Config and rejected at
// construction (NewWithConfig) when non-positive, so a malformed Store can
// never exist. The tunable family is enumerated here in full: a future tunable
// added to Config without a matching row below (and a matching clause in
// Config.validate) is an obvious gap in this detector. The runtime
// /vh/diag/invariants `tunables-sane` entry named by the brief is deliberately
// out of scope (spec only) — this construction-time check is the structural
// guard, and defense-in-depth diagnostics are supplemental observability.

import (
	"fmt"
	"testing"
	"time"
)

// TestTunablesRejectNonPositive is the M6 standing-check. It enumerates the
// full tunable family from Config and asserts NewWithConfig rejects a
// non-positive value for each — even when every OTHER tunable is at its sane
// DefaultConfig baseline — returning a non-nil error and a nil Store.
func TestTunablesRejectNonPositive(t *testing.T) {
	// Each row pins one member of the tunable family. `set` mutates exactly
	// that one field on an otherwise-sane Config to the (non-positive) value v.
	cases := []struct {
		name string
		set  func(cfg *Config, v int)
	}{
		{"RingCapacity", func(c *Config, v int) { c.RingCapacity = v }},
		{"CompletionGrace", func(c *Config, v int) { c.CompletionGrace = time.Duration(v) }},
		{"DeltaFlushInterval", func(c *Config, v int) { c.DeltaFlushInterval = time.Duration(v) }},
		{"PartTextCap", func(c *Config, v int) { c.PartTextCap = v }},
		{"WindowMaxCount", func(c *Config, v int) { c.WindowMaxCount = v }},
		{"WindowMaxBytes", func(c *Config, v int) { c.WindowMaxBytes = v }},
		{"RecentArchiveTTL", func(c *Config, v int) { c.RecentArchiveTTL = time.Duration(v) }},
		{"RecentBucketRetentionMinutes", func(c *Config, v int) { c.RecentBucketRetentionMinutes = v }},
	}
	for _, tc := range cases {
		for _, v := range []int{0, -1} {
			t.Run(fmt.Sprintf("%s=%d", tc.name, v), func(t *testing.T) {
				cfg := DefaultConfig(64) // sane baseline for every other field
				tc.set(&cfg, v)
				s, err := NewWithConfig(cfg)
				if err == nil {
					t.Fatalf("NewWithConfig accepted non-positive %s=%d: want error, got store %#v", tc.name, v, s)
				}
				if s != nil {
					t.Fatalf("NewWithConfig returned non-nil store (%#v) alongside error for %s=%d", s, tc.name, v)
				}
			})
		}
	}

	// The package-default configuration MUST be accepted: the New
	// compatibility wrapper relies on this path, so a regression here would
	// panic every New(N) call across the suite.
	t.Run("DefaultConfigAccepted", func(t *testing.T) {
		s, err := NewWithConfig(DefaultConfig(64))
		if err != nil {
			t.Fatalf("DefaultConfig(64) rejected: %v", err)
		}
		if s == nil {
			t.Fatal("DefaultConfig(64) returned nil store with nil error")
		}
	})

	// recentBucketRetentionMinutes is instance-owned (L-15 done-criterion:
	// "recentBucketRetentionMinutes is a Store instance field read under
	// s.mu"). A Config value that differs from the default must reach the
	// instance field — proving the former package-global hot-path read is gone
	// and the value is read under s.mu (the evictRecentBucketsLocked reader
	// runs under s.mu; this test reads it under RLock to mirror that).
	t.Run("RecentBucketRetentionMinutesInstanceOwned", func(t *testing.T) {
		cfg := DefaultConfig(64)
		cfg.RecentBucketRetentionMinutes = 7
		s, err := NewWithConfig(cfg)
		if err != nil {
			t.Fatalf("NewWithConfig rejected valid cfg: %v", err)
		}
		s.mu.RLock()
		got := s.recentBucketRetentionMinutes
		s.mu.RUnlock()
		if got != 7 {
			t.Fatalf("recentBucketRetentionMinutes not instance-owned from Config: want 7, got %d", got)
		}
	})
}
