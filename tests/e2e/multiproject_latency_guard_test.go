package e2e

import "testing"

// TestMultiProjectLatencyGuard is the PR-facing LATENCY regression guard that
// the test-speed plan slice 3 added alongside splitting the browser soak out
// of lane 6 (researches/decisions/test-suite-speed.md, option 2): the
// seven-page browser soak (web/tests/e2e/multiproject-soak.spec.ts) now runs
// dispatch-only, so THIS test keeps a cheap per-PR watch on the same class of
// multi-project contention regressions at the API seam.
//
// Why a new test instead of thresholds inside TestMultiProjectContentionBaseline
// (the preferred shape the plan named): the baseline is a MEASUREMENT ruler —
// its contract is deliberately threshold-free ("It measures and REPORTS; the
// only pass criteria are STRUCTURAL", multiproject_latency_test.go:9-10) — and
// it runs a 6-cluster cold/warm × direct/tunnel matrix whose cold rows exist
// to be *contrasted*, not gated. Thresholding that matrix would corrupt the
// ruler's contract and couple its flakiest rows (single-sample cold opens) to
// PR greenness. This guard instead runs ONE cluster at the contention level
// the browser soak watched (p=7), on the WARM regime with 3 reps (the
// baseline's own median-robustness shape), and gates only generous upper
// bounds on those rows.
//
// THRESHOLD DERIVATION (honest, cited):
//
//	Observed (TestMultiProjectContentionBaseline, same helpers, this repo,
//	2026-11-07 local run, go test -v receipt): p=7 warm DIRECT totals
//	tree med 2.81ms / max 7.88ms, session med 7.06ms / max 10.07ms; p=7 warm
//	TUNNEL totals tree med 16.51ms / max 21.38ms, session med 18.04ms /
//	max 22.55ms.
//
//	The browser soak's own timing watch (the thing being replaced per-PR) was
//	bounded-completion class, not tight budgets: 25s cold-hydrate per page,
//	20s live DOM-progress-to-final-tick, 30-40s per-scenario run budgets. The
//	regression family it existed to catch is CATASTROPHIC contention — the
//	A1 brief's head-of-line / tunnel-fairness shapes where medians inflate
//	100-1000× (ms → seconds), not 2-3× degradations.
//
//	Thresholds below sit ~55-90× above the observed LOCAL medians and
//	~220-300× above the observed LOCAL maxima (per bound: direct tree med
//	250/2.81≈89×, direct session med 500/7.06≈71×, tunnel meds
//	1000/16.5≈61× and 1000/18.0≈55×; direct tree max 2000/7.88≈254×,
//	direct session max 3000/10.07≈298×, tunnel maxes 5000/21.4≈234× and
//	5000/22.6≈222×). CI contention evidence: CI runs
//	these loopback paths ~2-3× slower than a clean dev machine (the soak's
//	filler was 93% done at 3× its local time in CI; 4d612ed widened a WAIT
//	5s→30s for CI ticker stalls — a wait-based mechanism, not stream
//	throughput). Even a 10× CI miss stays ~7× under the direct thresholds.
//	A regression that 100×'s the medians (the guarded class) trips them with
//	room to spare; a wedged-tail shape (median fair, max ballooning) is
//	caught by the max bounds.
const (
	mpGuardTreeMedMs    = 250.0  // direct warm tree total median (obs 2.81ms)
	mpGuardSessionMedMs = 500.0  // direct warm session total median (obs 7.06ms)
	mpGuardTreeMaxMs    = 2000.0 // direct warm tree total max (obs 7.88ms)
	mpGuardSessionMaxMs = 3000.0 // direct warm session total max (obs 10.07ms)

	mpGuardTunnelMedMs = 1000.0 // tunnel warm tree+session total median (obs 16.5/18.0ms)
	mpGuardTunnelMaxMs = 5000.0 // tunnel warm tree+session total max (obs 21.4/22.6ms)
)

// TestMultiProjectLatencyGuard runs one self-bootstrapped cluster at p=7 (the
// browser soak's project count), one cold burst (first-contact absorption,
// ungated) and three warm bursts per route, then bounds the warm rows.
// Structural correctness (streams terminate, snapshots carry the exact
// session count) is asserted by mpTabBurst itself, so the guard re-proves the
// API-level substrate on every PR run too.
func TestMultiProjectLatencyGuard(t *testing.T) {
	rec := newMPRecorder()
	m := startMPCluster(t)
	defer m.Close()
	dirs := mpBootstrapDirs(t, m.Cluster, 7)

	for _, route := range []mpRoute{mpDirect(m.Cluster), mpTunnel(m.Cluster)} {
		mpTabBurst(t, rec, m.Cluster, route, dirs, "cold", 1) // ungated absorption pass
		mpTabBurst(t, rec, m.Cluster, route, dirs, "warm", 3) // the guarded regime
	}
	rec.printRows(t)

	type bound struct {
		class          string
		route          string
		medMax, maxMax float64
	}
	for _, b := range []bound{
		{"tree", "direct", mpGuardTreeMedMs, mpGuardTreeMaxMs},
		{"session", "direct", mpGuardSessionMedMs, mpGuardSessionMaxMs},
		{"tree", "tunnel", mpGuardTunnelMedMs, mpGuardTunnelMaxMs},
		{"session", "tunnel", mpGuardTunnelMedMs, mpGuardTunnelMaxMs},
	} {
		med, ok := rec.medOf("warm", b.route, b.class)
		if !ok {
			t.Errorf("[latency-guard] no warm %s/%s row recorded — the guard ran without proving its regime", b.route, b.class)
			continue
		}
		if med > b.medMax {
			t.Errorf("[latency-guard] warm %s %s total median %.2fms exceeds the %.0fms budget (contention regression: 7-project demand is starving the stream path)", b.route, b.class, med, b.medMax)
		}
		mx, ok := rec.maxOf("warm", b.route, b.class)
		if ok && mx > b.maxMax {
			t.Errorf("[latency-guard] warm %s %s total max %.2fms exceeds the %.0fms budget (wedged-tail shape: median fair, worst case ballooned)", b.route, b.class, mx, b.maxMax)
		}
	}
}
