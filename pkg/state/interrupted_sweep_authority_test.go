package state

import (
	"encoding/json"
	"testing"
	"time"
)

// This file pins the false-VHSolaraInterruptedError fix (bug report
// 2026-10-14, "False interrupted marker after restart" family — session
// ses_eca48ca7bffekYbArar2VLqW7n). Mechanism (verified at HEAD): a prior
// turn's LIVE session.idle arms completionAuthoritative + liveIdleObserved
// over its completed assistant; idle reconcile ticks prime notBusyOnce; a
// later restart (or any missed live busy) followed by a NEW turn leaves the
// new turn's truthful busy statuses observation converted busy→idle by the
// Lane A authority guard BEFORE the notBusyOnce reset chokepoint — so the
// d-F1 "ANY busy-class signal resets" contract is unreachable and the clear
// path's sweep marks the LIVE uncompleted assistant as interrupted.
//
// The fix (approach B): the arm sites record WHAT the authority was armed
// over (the newest assistant identity + the created-key high-water of the
// whole arm-time message view); a busy/retry statuses observation under an
// armed authority disarms it only when the session's newest assistant
// carries a created key STRICTLY newer than that high-water and is still
// uncompleted — independent new-turn provenance that a #2696 post-terminal
// trap row (old/equal/unkeyed created) can never satisfy.

// seedArmedAuthorityOverCompletedTurn drives one full prior turn on sid
// through the LIVE stream — assistant m1 inflight → completed → LIVE
// session.idle — leaving exactly the bug's precondition:
// completionAuthoritative + liveIdleObserved armed over m1's completion,
// activity idle. Returns m1's id.
func seedArmedAuthorityOverCompletedTurn(t *testing.T, s *Store, sid string) string {
	t.Helper()
	s.Apply(ev("session.created", evSessionCreated(sid, "")))
	s.Apply(ev("message.updated", `{"info":{"id":"u1","sessionID":"`+sid+`","role":"user","time":{"created":5,"completed":6}}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"`+sid+`","role":"assistant","time":{"created":10}}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"`+sid+`","role":"assistant","time":{"created":10,"completed":15},"finish":"stop"}}`))
	s.Apply(ev("session.idle", evIdle(sid)))
	return "m1"
}

// authorityLatchState reads the three latches the bug family rides on,
// directly under the store lock (the same direct-map-read pattern as the
// F5-B assertion in turn_state_test.go).
func authorityLatchState(s *Store, sid string) (auth, liveIdle, notBusy bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.completionAuthoritative[sid], s.liveIdleObserved[sid], s.notBusyOnce[sid]
}

// TestSweepArmedAuthorityNewerInflightTurnIsNotFalseMarked is the fix's
// crux repro, in both delivery variants of the missed live busy:
//   - variant (a) "live-wedge": the new turn's assistant arrives via LIVE
//     message.updated — the #2696 guard (correctly) refuses the post-idle
//     busy escalation, which is how the authority stays armed despite a
//     resident newer inflight row;
//   - variant (b) "hydrate-learned": the new turn's assistant is learned
//     from a reconnect hydrate (SetSessionMessages) — the reporter's shape.
//
// In both, the next TRUTHFUL busy statuses observation must not be converted
// to idle, must reset notBusyOnce (d-F1), must not sweep the live turn, and
// the turn must complete normally with no synthetic marker ever emitted.
func TestSweepArmedAuthorityNewerInflightTurnIsNotFalseMarked(t *testing.T) {
	for _, variant := range []string{"live-wedge", "hydrate-learned"} {
		t.Run(variant, func(t *testing.T) {
			// Long grace: turn boundaries in this test are driven by LIVE
			// session.idle events (which cancel any armed grace), so no
			// timer ever fires — deterministic, no sleeps.
			s := mustNew(t, withCompletionGrace(DefaultConfig(256), time.Hour))
			defer s.Close()
			const sid = "R"
			m1 := seedArmedAuthorityOverCompletedTurn(t, s, sid)

			// (1) Both latches armed by the live session.idle.
			auth, liveIdle, _ := authorityLatchState(s, sid)
			if !auth || !liveIdle {
				t.Fatalf("seed: latches must be armed after live session.idle (auth=%v liveIdle=%v)", auth, liveIdle)
			}
			if a := gateActivity(s, sid); a != ActivityIdle {
				t.Fatalf("seed: activity=%q, want idle", a)
			}

			ch, stop := s.Subscribe(256)
			defer stop()

			// (2) One not-busy observation primes the d-F1 latch (in
			// production: hours of idle reconcile ticks).
			observeNotBusy(s)
			if _, _, notBusy := authorityLatchState(s, sid); !notBusy {
				t.Fatalf("prime: notBusyOnce must be set after the first not-busy observation")
			}

			// (3) THE MISS: no further live status events. The new turn's
			// assistant m2 (created AFTER the armed-over m1) becomes
			// resident without any live busy signal clearing the latches.
			if variant == "live-wedge" {
				s.Apply(ev("message.updated", `{"info":{"id":"m2","sessionID":"`+sid+`","role":"assistant","time":{"created":30}}}`))
				// #2696 wedge pin: the post-idle guard refuses the busy
				// escalation (intended, both at HEAD and after the fix —
				// only authoritative runner status may reopen a turn).
				if a := gateActivity(s, sid); a != ActivityIdle {
					t.Fatalf("wedge pin: activity=%q after post-idle inflight message, want idle (#2696 guard)", a)
				}
			} else {
				s.SetSessionMessages(sid, []MessageWithParts{{
					Info: json.RawMessage(`{"id":"m2","sessionID":"` + sid + `","role":"assistant","time":{"created":30}}`),
				}})
				if a := gateActivity(s, sid); a != ActivityIdle {
					t.Fatalf("hydrate seed: activity=%q, want idle (a fetch must not escalate)", a)
				}
			}

			// (4) TRUTHFUL busy statuses observation (the new turn is
			// running upstream). At HEAD the armed authority converts it to
			// idle (THE BUG); after the fix the newer uncompleted m2 is
			// new-turn evidence: the authority disarms and the busy flows.
			s.SetActivityFromStatuses(map[string]json.RawMessage{
				sid: json.RawMessage(`{"type":"busy"}`),
			})
			if a := gateActivity(s, sid); a != ActivityBusy {
				t.Fatalf("truthful busy under armed authority: activity=%q, want busy (the newer uncompleted assistant is new-turn evidence)", a)
			}

			// (5) The primed latch must NOT have swept the live turn in the
			// same call: m2 unmarked, both latches cleared, notBusyOnce
			// reset by the busy-class write (d-F1 contract), turn adopted.
			if c, te, syn := orphanState(t, s, sid, "m2"); c || te != "" || syn {
				t.Fatalf("BUG: live new turn false-marked interrupted: completed=%v err=%q syn=%v", c, te, syn)
			}
			auth, liveIdle, notBusy := authorityLatchState(s, sid)
			if auth || liveIdle {
				t.Fatalf("post-busy: latches must be disarmed (auth=%v liveIdle=%v)", auth, liveIdle)
			}
			if notBusy {
				t.Fatalf("post-busy: notBusyOnce must be reset by the busy-class activity write (d-F1)")
			}
			assertTurn(t, s, sid, TurnRunning, "truthful busy adopts the new turn as TurnRunning")
			// m1's real terminal untouched.
			if c, te, syn := orphanState(t, s, sid, m1); !c || te != "" || syn {
				t.Fatalf("prior turn's real terminal disturbed: completed=%v err=%q syn=%v", c, te, syn)
			}

			// (6) The turn completes NORMALLY: upstream writes the real
			// terminal, live session.idle follows, and subsequent not-busy
			// observations must find nothing to sweep.
			s.Apply(ev("message.updated", `{"info":{"id":"m2","sessionID":"`+sid+`","role":"assistant","time":{"created":30,"completed":40},"finish":"stop"}}`))
			s.Apply(ev("session.idle", evIdle(sid)))
			sweepClear(s)
			if c, te, syn := orphanState(t, s, sid, "m2"); !c || te != "" || syn {
				t.Fatalf("normal completion must carry only its REAL terminal: completed=%v err=%q syn=%v", c, te, syn)
			}
			// Emit scan: no synthetic marker was EVER emitted for m2.
			for {
				select {
				case e := <-ch:
					if e.Kind != KindMessageUpsert {
						continue
					}
					var info map[string]any
					if json.Unmarshal(e.Payload, &info) != nil || info["id"] != "m2" {
						continue
					}
					if errObj, ok := info["error"].(map[string]any); ok && errObj["name"] == InterruptedTurnErrorName {
						t.Fatalf("synthetic marker was EMITTED for a turn that completed normally")
					}
				default:
					return
				}
			}
		})
	}
}

// TestSweepArmedAuthoritySameTurnStaleBusyStillBlocked is the Lane A
// constraint pin: a stale busy from /session/status for the SAME turn the
// authority was armed over (no newer assistant exists; the newest assistant
// is the completed row the authority was armed on) must stay converted to
// idle — the guard that prevents the stranded "1 running" root. The busy
// observation must not disarm the authority and must not re-escalate.
func TestSweepArmedAuthoritySameTurnStaleBusyStillBlocked(t *testing.T) {
	s := mustNew(t, withCompletionGrace(DefaultConfig(256), time.Hour))
	defer s.Close()
	const sid = "R"
	m1 := seedArmedAuthorityOverCompletedTurn(t, s, sid)
	observeNotBusy(s) // prime

	s.SetActivityFromStatuses(map[string]json.RawMessage{
		sid: json.RawMessage(`{"type":"busy"}`),
	})
	if a := gateActivity(s, sid); a != ActivityIdle {
		t.Fatalf("Lane A: stale same-turn busy re-escalated activity to %q — the armed authority must force idle", a)
	}
	auth, _, _ := authorityLatchState(s, sid)
	if !auth {
		t.Fatalf("Lane A: the busy observation must NOT disarm the authority (newest assistant is the completed armed-over row)")
	}
	// And nothing ever marked the completed row.
	sweepClear(s)
	if c, te, syn := orphanState(t, s, sid, m1); !c || te != "" || syn {
		t.Fatalf("Lane A: completed prior turn must keep its real terminal: completed=%v err=%q syn=%v", c, te, syn)
	}
}

// TestSweepArmedAuthoritySameRowReserveStaysBlocked is the #2696 constraint
// pin at the STATUSES seam: OpenCode's post-idle fs-snapshot stamping
// re-serves the SAME row the authority was armed over (here: m1's body
// re-served without time.completed, making it look inflight again). That
// row is NOT newer than the arm — the authority must hold and the stale
// busy must stay idle. (What the sweep eventually does with a trap row on
// the not-busy path is the pre-existing d-F1-gated behavior, unchanged and
// out of scope here.)
func TestSweepArmedAuthoritySameRowReserveStaysBlocked(t *testing.T) {
	s := mustNew(t, withCompletionGrace(DefaultConfig(256), time.Hour))
	defer s.Close()
	const sid = "R"
	seedArmedAuthorityOverCompletedTurn(t, s, sid)
	observeNotBusy(s) // prime

	// The trap: the SAME row re-served uncompleted (no time.completed) after
	// the observed idle — #2696's mutable-record stamping. The live-path
	// guard refuses the re-escalation...
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"`+sid+`","role":"assistant","time":{"created":10},"tokens":{"input":3}}}`))
	if a := gateActivity(s, sid); a != ActivityIdle {
		t.Fatalf("#2696 pin: trap re-serve re-escalated activity to %q", a)
	}

	// ...and the statuses seam must not disarm for it either (same row, not
	// newer): the busy stays blocked.
	s.SetActivityFromStatuses(map[string]json.RawMessage{
		sid: json.RawMessage(`{"type":"busy"}`),
	})
	if a := gateActivity(s, sid); a != ActivityIdle {
		t.Fatalf("#2696 pin: stale busy over the SAME armed-over row re-escalated activity to %q", a)
	}
	auth, _, _ := authorityLatchState(s, sid)
	if !auth {
		t.Fatalf("#2696 pin: the authority must stay armed over the same-row re-serve")
	}
}

// TestSweepArmedAuthorityDrainPreservesStopping pins D4 against the fix in
// both drain shapes:
//   - shape 1 (the production drain): the draining turn started through
//     AUTHORITATIVE live busy, which cleared the authority when the turn
//     began — the fix's authority check is never reached, D4 behaves exactly
//     as before;
//   - shape 2 (armed + wedged): the authority stayed armed across the new
//     turn's start (the missed-busy wedge) and a Stop is draining it. The
//     truthful busy statuses observation now disarms (newer uncompleted
//     assistant) and records truthful busy activity — but the reconcile
//     snapshot must STILL not re-adopt the draining turn: TurnStopping and
//     the closed abort gate are preserved by markTurnRunningLocked's D4
//     provenance guard. At HEAD this shape force-settled the stop on the
//     converted idle (opening the gate mid-drain) — the fix keeps the drain
//     fail-closed, which is D4's contract.
func TestSweepArmedAuthorityDrainPreservesStopping(t *testing.T) {
	t.Run("drain_without_authority_unchanged", func(t *testing.T) {
		s := mustNew(t, withCompletionGrace(DefaultConfig(256), time.Hour))
		defer s.Close()
		const sid = "R"
		s.Apply(ev("session.created", evSessionCreated(sid, "")))
		s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"`+sid+`","role":"assistant","time":{"created":10}}}`))
		s.Apply(ev("session.status", evStatus(sid, "busy"))) // authoritative turn start
		assertTurn(t, s, sid, TurnRunning, "turn running")
		s.Stop(sid, "m1")
		assertTurn(t, s, sid, TurnStopping, "after Stop")

		// Reconcile-snapshot busy during the drain: D4 preserves stopping.
		s.SetActivityFromStatuses(map[string]json.RawMessage{
			sid: json.RawMessage(`{"type":"busy"}`),
		})
		assertTurn(t, s, sid, TurnStopping, "D4: reconcile-snapshot busy during drain preserves TurnStopping")
		if !s.AbortSettling(sid) {
			t.Fatalf("D4: the abort gate must stay CLOSED during the drain")
		}
		if a := gateActivity(s, sid); a != ActivityBusy {
			t.Fatalf("D4: activity=%q during drain, want busy (the canceled run is still draining)", a)
		}
	})

	t.Run("armed_wedge_drain_keeps_gate_closed", func(t *testing.T) {
		s := mustNew(t, withCompletionGrace(DefaultConfig(256), time.Hour))
		defer s.Close()
		const sid = "R"
		seedArmedAuthorityOverCompletedTurn(t, s, sid)
		observeNotBusy(s) // prime
		// The wedged new turn: m2 inflight via the live stream (the #2696
		// guard refuses the escalation, so the authority stays armed), then
		// the operator stops it mid-flight.
		s.Apply(ev("message.updated", `{"info":{"id":"m2","sessionID":"`+sid+`","role":"assistant","time":{"created":30}}}`))
		s.Stop(sid, "m2")
		assertTurn(t, s, sid, TurnStopping, "after Stop on the wedged turn")

		// Truthful busy while the abort drains: the fix disarms (newer
		// uncompleted m2) and records truthful busy activity, but the
		// reconcile snapshot must NOT re-adopt — D4 holds.
		s.SetActivityFromStatuses(map[string]json.RawMessage{
			sid: json.RawMessage(`{"type":"busy"}`),
		})
		assertTurn(t, s, sid, TurnStopping, "D4: armed+wedged drain still preserves TurnStopping (no re-adoption)")
		if !s.AbortSettling(sid) {
			t.Fatalf("D4: the abort gate must stay CLOSED during the armed+wedged drain")
		}
		if a := gateActivity(s, sid); a != ActivityBusy {
			t.Fatalf("D4: activity=%q during armed+wedged drain, want busy (truthful drain status)", a)
		}
		// And the sweep did not mark the draining turn in the same call.
		if c, te, syn := orphanState(t, s, sid, "m2"); c || te != "" || syn {
			t.Fatalf("D4: draining turn marked interrupted: completed=%v err=%q syn=%v", c, te, syn)
		}
	})
}

// TestSweepArmedAuthorityKilledTurnStillMarked is the C5 constraint pin
// (orphan heal unchanged): approach B only alters BUSY observations. A
// genuinely killed turn (restart-killed row learned from a fetch, statuses
// truthfully idle, no live activity) is still marked within the
// two-observation contract exactly as before — identical at HEAD and after
// the fix.
func TestSweepArmedAuthorityKilledTurnStillMarked(t *testing.T) {
	s := mustNew(t, withCompletionGrace(DefaultConfig(256), time.Hour))
	defer s.Close()
	const sid = "R"
	seedArmedAuthorityOverCompletedTurn(t, s, sid)

	// The restart kills turn 2 mid-flight; the reconnect fetch serves its
	// uncompleted row (no live activity — statuses will truthfully report
	// not-busy).
	s.SetSessionMessages(sid, []MessageWithParts{{
		Info: json.RawMessage(`{"id":"m3","sessionID":"` + sid + `","role":"assistant","time":{"created":30}}`),
	}})

	// Two consecutive not-busy observations: prime, then sweep → marked.
	sweepClear(s)
	c, te, syn := orphanState(t, s, sid, "m3")
	if !c || te != InterruptedTurnErrorName || !syn {
		t.Fatalf("C5: killed turn must still be marked within the two-observation contract: completed=%v err=%q syn=%v", c, te, syn)
	}
}

// TestSweepArmedAuthorityPostTerminalTrapRowStaleBusyStaysBlocked holds the
// commit-review F4 line: a post-terminal MUTABLE row (the #2696 trap — an
// old record re-served or patched after the observed terminal) followed by a
// STALE busy statuses snapshot must NOT be accepted as new-turn evidence.
// The discriminator proves newness by the row's own created key being
// STRICTLY newer than the arm-time high-water of the resident message view —
// a trap row either re-serves an old key (<= high-water), carries an equal
// key (a same-ms stamp), or carries no key at all (the stylized patched
// row), and none of those can prove newness. These are composed regressions
// of the #2696 guard (turn_state_test.go
// TestP7_PostIdleMutableMessageDoesNotReopenTurn) and its session.error twin
// at the STATUSES seam.
func TestSweepArmedAuthorityPostTerminalTrapRowStaleBusyStaysBlocked(t *testing.T) {
	// (a) The F4 counterexample verbatim: authority armed while NO assistant
	// was resident (live session.idle on a never-hydrated session), then the
	// stylized patched row arrives (unkeyed, inflight-looking), then the
	// stale busy snapshot. The arm-time record is empty, but the row cannot
	// PROVE it postdates the arm — refused.
	t.Run("armed_over_empty_unkeyed_trap_row", func(t *testing.T) {
		s := mustNew(t, withCompletionGrace(DefaultConfig(256), time.Hour))
		defer s.Close()
		const sid = "R"
		s.Apply(ev("session.created", evSessionCreated(sid, "")))
		s.Apply(ev("session.status", evStatus(sid, "busy"))) // turn 1 runs
		s.Apply(ev("session.idle", evIdle(sid)))             // terminal, NO messages resident
		auth, liveIdle, _ := authorityLatchState(s, sid)
		if !auth || !liveIdle {
			t.Fatalf("seed: latches must be armed (auth=%v liveIdle=%v)", auth, liveIdle)
		}
		observeNotBusy(s) // prime

		// The trap: the exact TestP7_PostIdleMutableMessageDoesNotReopenTurn
		// row — a mutable assistant record with NO time fields at all.
		s.Apply(ev("message.updated", evAssistantInflight(sid, "m_late")))
		if a := gateActivity(s, sid); a != ActivityIdle {
			t.Fatalf("trap Apply: #2696 guard must refuse escalation, got %q", a)
		}

		// Stale busy snapshot: must stay blocked.
		s.SetActivityFromStatuses(map[string]json.RawMessage{
			sid: json.RawMessage(`{"type":"busy"}`),
		})
		if a := gateActivity(s, sid); a != ActivityIdle {
			t.Fatalf("F4: stale busy over an unkeyed post-terminal trap row re-escalated activity to %q", a)
		}
		auth, _, _ = authorityLatchState(s, sid)
		if !auth {
			t.Fatalf("F4: the authority must hold over an unkeyed trap row (no provable newness)")
		}
		assertTurn(t, s, sid, TurnIdle, "F4: stale busy + trap row must not re-adopt TurnRunning")
	})

	// (b) Different-ID trap with an EQUAL created key: OpenCode's post-hoc
	// stamp lands on a copy of the just-finished turn's row (created == the
	// armed-over row's created, sorted after it by the stable insert). Order
	// position alone would call it "newer"; the strict created-key test must
	// refuse.
	t.Run("different_id_equal_created_trap_row", func(t *testing.T) {
		s := mustNew(t, withCompletionGrace(DefaultConfig(256), time.Hour))
		defer s.Close()
		const sid = "R"
		seedArmedAuthorityOverCompletedTurn(t, s, sid) // armed over m1 (created 10)
		observeNotBusy(s)                              // prime

		s.Apply(ev("message.updated", `{"info":{"id":"m1_stamp","sessionID":"`+sid+`","role":"assistant","time":{"created":10}}}`))
		if a := gateActivity(s, sid); a != ActivityIdle {
			t.Fatalf("trap Apply: #2696 guard must refuse escalation, got %q", a)
		}

		s.SetActivityFromStatuses(map[string]json.RawMessage{
			sid: json.RawMessage(`{"type":"busy"}`),
		})
		if a := gateActivity(s, sid); a != ActivityIdle {
			t.Fatalf("F4: stale busy over an equal-created trap row re-escalated activity to %q", a)
		}
		auth, _, _ := authorityLatchState(s, sid)
		if !auth {
			t.Fatalf("F4: the authority must hold over an equal-created trap row (created == arm-time high-water, not strictly newer)")
		}
		assertTurn(t, s, sid, TurnIdle, "F4: stale busy + equal-created trap row must not re-adopt")
	})

	// (c) The session.error twin of (a): an OBSERVED error terminal arms the
	// same authority pair; a post-terminal trap row + stale busy must stay
	// blocked there too.
	t.Run("session_error_twin_unkeyed_trap_row", func(t *testing.T) {
		s := mustNew(t, withCompletionGrace(DefaultConfig(256), time.Hour))
		defer s.Close()
		const sid = "R"
		s.Apply(ev("session.created", evSessionCreated(sid, "")))
		s.Apply(ev("session.status", evStatus(sid, "busy")))
		s.Apply(ev("session.error", evError(sid)))
		auth, liveIdle, _ := authorityLatchState(s, sid)
		if !auth || !liveIdle {
			t.Fatalf("seed: session.error must arm both latches (auth=%v liveIdle=%v)", auth, liveIdle)
		}
		observeNotBusy(s)

		s.Apply(ev("message.updated", evAssistantInflight(sid, "m_late")))
		s.SetActivityFromStatuses(map[string]json.RawMessage{
			sid: json.RawMessage(`{"type":"busy"}`),
		})
		if a := gateActivity(s, sid); a != ActivityIdle {
			t.Fatalf("F4 (error twin): stale busy over an unkeyed trap row re-escalated activity to %q", a)
		}
		auth, _, _ = authorityLatchState(s, sid)
		if !auth {
			t.Fatalf("F4 (error twin): the authority must hold")
		}
		assertTurn(t, s, sid, TurnIdle, "F4 (error twin): no re-adoption")
	})
}

// TestSweepArmedAuthorityUnanchoredViewRefusesAndNeverFalseMarks holds the
// commit-review round-2 line: when the arm-time view held no KEYED assistant
// (an empty or user-only view — a live terminal arriving after a reconnect
// gap swallowed the turn's rows), NO message-domain bound on the finished
// turn's rows exists, so the discriminator must refuse EVERY disarm — a
// previously-unseen row of the finished turn (normal old created key,
// completion stripped) must not pass just because the high-water saw
// nothing. The false-marker burden in that corner is carried by the
// busy-report sweep-skip: an AFFIRMATIVELY busy-class reported session never
// reaches the clear path, so a genuine live turn is never false-marked even
// when its disarm is refused — and the authoritative LIVE busy event remains
// the recovery path.
func TestSweepArmedAuthorityUnanchoredViewRefusesAndNeverFalseMarks(t *testing.T) {
	// (a) Round-2 F1 verbatim: authority armed with an EMPTY view, then a
	// KEYED prior-turn trap row (normal created, no completion), then the
	// stale busy snapshot. Old key over an unanchored arm must not disarm.
	t.Run("empty_view_keyed_old_trap_row", func(t *testing.T) {
		s := mustNew(t, withCompletionGrace(DefaultConfig(256), time.Hour))
		defer s.Close()
		const sid = "R"
		s.Apply(ev("session.created", evSessionCreated(sid, "")))
		s.Apply(ev("session.status", evStatus(sid, "busy"))) // turn 1 runs
		s.Apply(ev("session.idle", evIdle(sid)))             // terminal, NO messages resident
		observeNotBusy(s)                                    // prime

		// The finished turn's assistant row, first delivered AFTER the
		// terminal (reconnect gap), completion stripped — keyed created 10.
		s.Apply(ev("message.updated", `{"info":{"id":"m_late","sessionID":"`+sid+`","role":"assistant","time":{"created":10}}}`))
		s.SetActivityFromStatuses(map[string]json.RawMessage{
			sid: json.RawMessage(`{"type":"busy"}`),
		})
		if a := gateActivity(s, sid); a != ActivityIdle {
			t.Fatalf("unanchored: keyed old trap row + stale busy re-escalated activity to %q", a)
		}
		auth, _, _ := authorityLatchState(s, sid)
		if !auth {
			t.Fatalf("unanchored: the authority must hold (no sound newness bound exists)")
		}
		assertTurn(t, s, sid, TurnIdle, "unanchored: no re-adoption")
		// The blocked busy report RESET the d-F1 latch (an affirmative
		// busy-class report ends the not-busy run), so ONE following
		// not-busy observation only re-primes — the trap row is not swept.
		observeNotBusy(s)
		if c, te, syn := orphanState(t, s, sid, "m_late"); c || te != "" || syn {
			t.Fatalf("unanchored: trap row swept off one post-busy not-busy observation: completed=%v err=%q syn=%v", c, te, syn)
		}
	})

	// (b) Round-2 F1 partial view: the arm-time view holds the finished
	// turn's USER row (created 5) but no assistant. The turn's own assistant
	// (created 10, unseen at arm) arriving post-terminal uncompleted must
	// not disarm — 10 > 5 proves nothing when the bound never covered the
	// turn's assistant rows.
	t.Run("partial_view_unseen_finished_turn_assistant", func(t *testing.T) {
		s := mustNew(t, withCompletionGrace(DefaultConfig(256), time.Hour))
		defer s.Close()
		const sid = "R"
		s.Apply(ev("session.created", evSessionCreated(sid, "")))
		s.Apply(ev("message.updated", `{"info":{"id":"u1","sessionID":"`+sid+`","role":"user","time":{"created":5,"completed":6}}}`))
		s.Apply(ev("session.idle", evIdle(sid))) // terminal; user-only view
		observeNotBusy(s)                        // prime

		s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"`+sid+`","role":"assistant","time":{"created":10}}}`))
		s.SetActivityFromStatuses(map[string]json.RawMessage{
			sid: json.RawMessage(`{"type":"busy"}`),
		})
		if a := gateActivity(s, sid); a != ActivityIdle {
			t.Fatalf("partial view: unseen finished-turn assistant + stale busy re-escalated activity to %q", a)
		}
		auth, _, _ := authorityLatchState(s, sid)
		if !auth {
			t.Fatalf("partial view: the authority must hold (the armed view never bounded the turn's assistant rows)")
		}
		// One post-busy not-busy observation re-primes only — no sweep.
		observeNotBusy(s)
		if c, te, syn := orphanState(t, s, sid, "m1"); c || te != "" || syn {
			t.Fatalf("partial view: row swept off one post-busy not-busy observation: completed=%v err=%q syn=%v", c, te, syn)
		}
	})

	// (c) The honest residual POSITIVE: on an unanchored arm, a GENUINE new
	// turn is not adopted by its first truthful busy observation (the
	// pre-existing #2696-wedge posture — the safe direction), but it is
	// NEVER false-marked: the busy report is skipped from the clear path
	// (no sweep authority), the turn completes normally, and the
	// authoritative LIVE busy event remains the recovery path that adopts.
	t.Run("unanchored_genuine_turn_never_marked_live_busy_recovers", func(t *testing.T) {
		s := mustNew(t, withCompletionGrace(DefaultConfig(256), time.Hour))
		defer s.Close()
		const sid = "R"
		s.Apply(ev("session.created", evSessionCreated(sid, "")))
		s.Apply(ev("session.status", evStatus(sid, "busy"))) // turn 1 runs
		s.Apply(ev("session.idle", evIdle(sid)))             // terminal, empty view
		observeNotBusy(s)                                    // prime (hours of idle ticks)

		// A genuine new turn: keyed assistant created 30, learned via fetch
		// (the missed-busy shape). The disarm is REFUSED (unanchored), the
		// activity stays idle — but the busy report must not feed the sweep.
		s.SetSessionMessages(sid, []MessageWithParts{{
			Info: json.RawMessage(`{"id":"m2","sessionID":"` + sid + `","role":"assistant","time":{"created":30}}`),
		}})
		s.SetActivityFromStatuses(map[string]json.RawMessage{
			sid: json.RawMessage(`{"type":"busy"}`),
		})
		if c, te, syn := orphanState(t, s, sid, "m2"); c || te != "" || syn {
			t.Fatalf("CRUX: unanchored genuine live turn false-marked on an affirmative busy report: completed=%v err=%q syn=%v", c, te, syn)
		}
		if a := gateActivity(s, sid); a != ActivityIdle {
			t.Fatalf("unanchored: activity=%q, want idle (disarm refused — the honest wedge posture)", a)
		}
		auth, _, _ := authorityLatchState(s, sid)
		if !auth {
			t.Fatalf("unanchored: authority must hold")
		}

		// Commit-review round-3 F2 sequence, verbatim: the blocked busy
		// report RESET the d-F1 latch, so ONE subsequent not-busy
		// observation only re-primes — the still-live turn is NOT swept.
		// (Without the reset this single observation consumed the stale
		// primed latch and stamped VHSolaraInterruptedError on m2.)
		observeNotBusy(s)
		_, _, notBusy := authorityLatchState(s, sid)
		if !notBusy {
			t.Fatalf("round-3 F2: the post-busy not-busy observation must re-prime the latch")
		}
		if c, te, syn := orphanState(t, s, sid, "m2"); c || te != "" || syn {
			t.Fatalf("round-3 F2 CRUX: live turn false-marked off ONE post-busy not-busy observation: completed=%v err=%q syn=%v", c, te, syn)
		}

		// The authoritative recovery path: a LIVE session.status busy event
		// clears the authority unconditionally and adopts the turn.
		s.Apply(ev("session.status", evStatus(sid, "busy")))
		if a := gateActivity(s, sid); a != ActivityBusy {
			t.Fatalf("recovery: live busy must set activity busy, got %q", a)
		}
		assertTurn(t, s, sid, TurnRunning, "recovery: live busy adopts")
		auth, liveIdle, _ := authorityLatchState(s, sid)
		if auth || liveIdle {
			t.Fatalf("recovery: live busy must clear both latches (auth=%v liveIdle=%v)", auth, liveIdle)
		}

		// The turn completes normally; no synthetic marker ever exists.
		s.Apply(ev("message.updated", `{"info":{"id":"m2","sessionID":"`+sid+`","role":"assistant","time":{"created":30,"completed":40},"finish":"stop"}}`))
		s.Apply(ev("session.idle", evIdle(sid)))
		sweepClear(s)
		if c, te, syn := orphanState(t, s, sid, "m2"); !c || te != "" || syn {
			t.Fatalf("normal completion must carry only its REAL terminal: completed=%v err=%q syn=%v", c, te, syn)
		}
	})
}

// TestSweepArmedAuthorityOlderTurnAssistantViewRefuses is the commit-review
// round-3 regression (i) with its round-4 variants: the arm-time view holds
// a keyed COMPLETED assistant from an EARLIER turn plus the finished turn's
// own USER prompt sitting AFTER it — keyed (round 3), KEYLESS (a placeholder
// that sorts at +∞, invisible to the keyed high-water — round 4 F1), or
// EQUAL-CREATED (stable-inserted after the assistant, leaving the keyed
// high-water untouched — round 4 F1). In every variant a row follows the
// armed-over assistant in ORDER — the signature that its turn's assistant
// rows may be unseen — so the anchor must fail and the finished turn's
// delayed assistant (keyed, uncompleted) + stale busy stays blocked.
func TestSweepArmedAuthorityOlderTurnAssistantViewRefuses(t *testing.T) {
	// promptBody builds the finished turn's user row for each variant
	// (wrapped in the message.updated {info:…} envelope):
	// keyed-newer (created 5), keyless (no time field — sorts last), or
	// equal-created (created 1 — stable-inserted after m0).
	promptBody := func(sid, variant string) string {
		switch variant {
		case "keyed_prompt":
			return `{"info":{"id":"u1","sessionID":"` + sid + `","role":"user","time":{"created":5,"completed":6}}}`
		case "keyless_prompt":
			return `{"info":{"id":"u1","sessionID":"` + sid + `","role":"user"}}`
		default: // equal_created_prompt
			return `{"info":{"id":"u1","sessionID":"` + sid + `","role":"user","time":{"created":1,"completed":1}}}`
		}
	}
	for _, variant := range []string{"keyed_prompt", "keyless_prompt", "equal_created_prompt"} {
		t.Run(variant, func(t *testing.T) {
			s := mustNew(t, withCompletionGrace(DefaultConfig(256), time.Hour))
			defer s.Close()
			const sid = "R"
			// An earlier turn's completed assistant (created 1)...
			s.Apply(ev("session.created", evSessionCreated(sid, "")))
			s.Apply(ev("message.updated", `{"info":{"id":"m0","sessionID":"`+sid+`","role":"assistant","time":{"created":1,"completed":2},"finish":"stop"}}`))
			s.Apply(ev("session.idle", evIdle(sid)))
			// ...then the finished turn runs with only its USER row
			// delivered (the turn's assistant rows were swallowed by a
			// gap), and its terminal arrives.
			s.Apply(ev("message.updated", promptBody(sid, variant)))
			s.Apply(ev("session.idle", evIdle(sid)))
			auth, _, _ := authorityLatchState(s, sid)
			if !auth {
				t.Fatalf("seed: authority must be armed by the second terminal")
			}
			observeNotBusy(s) // prime

			// The finished turn's assistant, first delivered AFTER the
			// terminal (created 10 > the armed view's keyed high-water):
			// the armed-over assistant (m0) is NOT the view's last row —
			// unanchored, refused.
			s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"`+sid+`","role":"assistant","time":{"created":10}}}`))
			s.SetActivityFromStatuses(map[string]json.RawMessage{
				sid: json.RawMessage(`{"type":"busy"}`),
			})
			if a := gateActivity(s, sid); a != ActivityIdle {
				t.Fatalf("%s: delayed finished-turn assistant over an older-turn-assistant view re-escalated activity to %q", variant, a)
			}
			auth, _, _ = authorityLatchState(s, sid)
			if !auth {
				t.Fatalf("%s: the authority must hold (the armed-over assistant was not the view's last row)", variant)
			}
			assertTurn(t, s, sid, TurnIdle, variant+": no re-adoption")

			// Round-4 F2 rider: the blocked busy report RESET the d-F1
			// latch, so ONE following not-busy observation only re-primes —
			// the row is not swept.
			observeNotBusy(s)
			if c, te, syn := orphanState(t, s, sid, "m1"); c || te != "" || syn {
				t.Fatalf("%s: row swept off one post-busy not-busy observation: completed=%v err=%q syn=%v", variant, c, te, syn)
			}
		})
	}
}

// TestSweepArmedAuthorityAcceptedResidual_StrippedUnseenStep pins the
// boundary the discriminator cannot close (commit-review round 2's dropped
// finding, rounds 3-4 accepted as bounded): when the FINAL step of a
// multi-step finished turn was never delivered (the resident view still
// anchors — the earlier step is its last row), a stripped-completion
// re-serve of that unseen step (created strictly past the high-water,
// uncompleted) is observably equivalent to the first row of a genuine new
// turn under every separator the store can actually consult. No established,
// complete turn-boundary separator exists in the v1 contract (message
// parentID links a response to its prompt but does not bound multi-step
// turns and is absent from the terminal events); the remaining candidates
// are rejected on the record: wall-clock comparison (forbidden by the fix's
// mission; cross-host skew turns it into a magic-window tunable),
// two-consecutive-busy generation counting (a persistently stale
// /session/status — the exact upstream failure completionAuthoritative
// exists for — would permanently re-strand Lane A), and upstream turn-id
// provenance (absent from the v1 event contract). This test pins the
// CURRENT behavior so the tradeoff is executable documentation: such a row
// disarms and the busy flows. The residual is re-adoption-only — this
// direction can never produce a false VHSolaraInterruptedError (the
// reported bug); it can only over-report a turn as busy, which
// self-corrects on the next truthful not-busy observation.
func TestSweepArmedAuthorityAcceptedResidual_StrippedUnseenStep(t *testing.T) {
	s := mustNew(t, withCompletionGrace(DefaultConfig(256), time.Hour))
	defer s.Close()
	const sid = "R"
	s.Apply(ev("session.created", evSessionCreated(sid, "")))
	// The finished multi-step turn: its user prompt + the FIRST assistant
	// step are resident; the final step never arrived before the terminal.
	s.Apply(ev("message.updated", `{"info":{"id":"u1","sessionID":"`+sid+`","role":"user","time":{"created":5,"completed":6}}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"a1","sessionID":"`+sid+`","role":"assistant","time":{"created":10,"completed":11},"finish":"stop"}}`))
	s.Apply(ev("session.idle", evIdle(sid)))
	observeNotBusy(s) // prime

	// The unseen final step, re-served post-terminal with its completion
	// stripped (created 12 > high-water 10): indistinguishable from a new
	// turn's first row — the accepted residual disarms.
	s.Apply(ev("message.updated", `{"info":{"id":"a2","sessionID":"`+sid+`","role":"assistant","time":{"created":12}}}`))
	s.SetActivityFromStatuses(map[string]json.RawMessage{
		sid: json.RawMessage(`{"type":"busy"}`),
	})
	if a := gateActivity(s, sid); a != ActivityBusy {
		t.Fatalf("accepted residual: the stripped unseen step must currently disarm (indistinguishable from a new turn), got %q", a)
	}
	// The over-report self-corrects on the first truthful not-busy
	// observation (busy→idle; the d-F1 latch re-primes). No marker exists
	// at one observation — and should the row never re-serve its real
	// terminal, any eventual marker is the sweep's DESIGNED two-observation
	// behavior on a truthful not-busy pair, superseded by upstream truth
	// (TestSweepRealTerminalSupersedes) when the authoritative completed
	// body is re-fetched.
	observeNotBusy(s)
	if a := gateActivity(s, sid); a != ActivityIdle {
		t.Fatalf("accepted residual: truthful not-busy must clear the over-reported busy, got %q", a)
	}
	if c, te, syn := orphanState(t, s, sid, "a2"); c || te != "" || syn {
		t.Fatalf("accepted residual: no false terminal may exist: completed=%v err=%q syn=%v", c, te, syn)
	}
}
