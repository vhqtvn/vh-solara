package alerts

import (
	"testing"
	"time"
)

func TestPresenceAttended(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	cur := base
	p := NewPresence()
	p.now = func() time.Time { return cur }
	window := 2 * time.Minute

	// Just interacted → attended.
	p.Heartbeat(Device{ID: "d1", LastInteraction: cur})
	if !p.Attended(window) {
		t.Error("should be attended right after an interaction")
	}

	// No new heartbeat for longer than the window → stale → not attended.
	cur = base.Add(3 * time.Minute)
	if p.Attended(window) {
		t.Error("a device whose last heartbeat is stale must not count as attended")
	}

	// Fresh heartbeat but the tab reports idle → not attended.
	p.Heartbeat(Device{ID: "d1", LastInteraction: cur, Idle: true})
	if p.Attended(window) {
		t.Error("an idle (hidden) device must not count as attended")
	}

	// Fresh heartbeat, but the last interaction is older than the window.
	p.Heartbeat(Device{ID: "d1", LastInteraction: base}) // lastSeen=cur, interaction 3m ago
	if p.Attended(window) {
		t.Error("interaction older than the window must not count as attended")
	}

	// A second device that just interacted → attended again.
	p.Heartbeat(Device{ID: "d2", LastInteraction: cur})
	if !p.Attended(window) {
		t.Error("a second, active device should make the user attended")
	}
}

func TestPresenceDevicesPrune(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	cur := base
	p := NewPresence()
	p.now = func() time.Time { return cur }
	p.Heartbeat(Device{ID: "d1"})
	cur = base.Add(10 * time.Minute)
	if got := p.Devices(5 * time.Minute); len(got) != 0 {
		t.Errorf("stale device should be pruned, got %d", len(got))
	}
}
