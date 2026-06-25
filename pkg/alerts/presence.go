package alerts

import (
	"sync"
	"time"
)

// Device is one connected browser/PWA's reported presence. A device heartbeats
// periodically; the daemon uses the aggregate to decide attendance.
type Device struct {
	ID              string    `json:"id"`
	Name            string    `json:"name,omitempty"`
	FocusedRoot     string    `json:"focusedRoot,omitempty"` // root session currently in view
	Scope           string    `json:"scope,omitempty"`       // off | current | all (per-device override; empty = use profile default)
	LastInteraction time.Time `json:"lastInteraction"`       // last real user interaction (tap/key)
	LastSeen        time.Time `json:"lastSeen"`              // last heartbeat
	Idle            bool      `json:"idle"`                  // client self-reported idle (e.g. tab hidden)
}

// Presence aggregates device heartbeats into an attendance signal.
type Presence struct {
	mu      sync.RWMutex
	devices map[string]*Device
	now     func() time.Time
}

func NewPresence() *Presence {
	return &Presence{devices: map[string]*Device{}, now: time.Now}
}

// Heartbeat records/updates a device's presence. Fields with zero values that
// the client omits are not clobbered for an existing device except those it
// always sends (LastSeen, Idle, FocusedRoot, Scope, LastInteraction).
func (p *Presence) Heartbeat(d Device) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	d.LastSeen = now
	if d.LastInteraction.IsZero() {
		d.LastInteraction = now
	}
	if existing := p.devices[d.ID]; existing != nil && d.Name == "" {
		d.Name = existing.Name
	}
	p.devices[d.ID] = &d
}

// Devices returns a snapshot of currently-known devices (those seen within the
// staleness window), pruning the rest.
func (p *Presence) Devices(staleAfter time.Duration) []Device {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	out := []Device{}
	for id, d := range p.devices {
		if now.Sub(d.LastSeen) > staleAfter {
			delete(p.devices, id)
			continue
		}
		out = append(out, *d)
	}
	return out
}

// Attended reports whether the user is actively present: any live device
// interacted within idleWindow and is not self-reported idle.
func (p *Presence) Attended(idleWindow time.Duration) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	now := p.now()
	for _, d := range p.devices {
		if now.Sub(d.LastSeen) > idleWindow {
			continue // stale heartbeat: device is gone, not attending
		}
		if d.Idle {
			continue
		}
		if now.Sub(d.LastInteraction) <= idleWindow {
			return true
		}
	}
	return false
}
