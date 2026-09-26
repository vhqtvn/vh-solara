package server

import (
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/tunnel"
)

// Worker represents a connected agent.
type Worker struct {
	ID        string
	Name      string
	Version   string
	Transport *tunnel.MuxTransport
	LastSeen  time.Time
	Status    string
}

// Registry manages connected workers.
type Registry struct {
	mu      sync.RWMutex
	workers map[string]*Worker

	// gen is the membership/liveness generation. Every mutation that changes
	// WHICH workers are registered or whether they are reachable (AddWorker,
	// RemoveWorker, MarkWorkerOffline, CleanupOfflineWorkers) bumps it;
	// UpdateHeartbeat deliberately does NOT. Consumers that cache a view of
	// the fleet (the fleet-status rollup service) capture the generation
	// under the lock when they build a cached generation and re-derive it
	// before serving: a mismatch means their cache is stale and must not be
	// served. This makes tunnel-WS close invalidate caches instantly, because
	// handleWorkerWS's deferred MarkWorkerOffline bumps the generation the
	// moment the tunnel dies.
	gen uint64
}

// NewRegistry creates a new worker registry.
func NewRegistry() *Registry {
	return &Registry{
		workers: make(map[string]*Worker),
	}
}

// AddWorker registers a new or reconnected worker.
func (r *Registry) AddWorker(w *Worker) {
	r.mu.Lock()
	defer r.mu.Unlock()

	// If the worker is already connected, close the old transport.
	if old, exists := r.workers[w.ID]; exists && old.Transport != nil {
		old.Transport.Close()
	}
	r.workers[w.ID] = w
	r.gen++
}

// RemoveWorker removes a worker by ID.
func (r *Registry) RemoveWorker(workerID string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if w, exists := r.workers[workerID]; exists {
		if w.Transport != nil {
			w.Transport.Close()
		}
		delete(r.workers, workerID)
		r.gen++
	}
}

// MarkWorkerOffline marks a worker as offline instead of removing it.
func (r *Registry) MarkWorkerOffline(workerID string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if w, exists := r.workers[workerID]; exists {
		if w.Transport != nil {
			w.Transport.Close()
			w.Transport = nil
		}
		w.Status = "offline"
		r.gen++
	}
}

// CleanupOfflineWorkers removes all workers that are currently marked as offline.
func (r *Registry) CleanupOfflineWorkers() {
	r.mu.Lock()
	defer r.mu.Unlock()

	removed := false
	for id, w := range r.workers {
		if w.Status == "offline" {
			delete(r.workers, id)
			removed = true
		}
	}
	if removed {
		r.gen++
	}
}

// UpdateHeartbeat bumps the LastSeen timestamp for a worker.
func (r *Registry) UpdateHeartbeat(workerID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if w, exists := r.workers[workerID]; exists {
		w.LastSeen = time.Now()
		return nil
	}
	return fmt.Errorf("worker not found: %s", workerID)
}

// GetWorker retrieves a connected worker safely.
func (r *Registry) GetWorker(workerID string) (*Worker, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	w, exists := r.workers[workerID]
	return w, exists
}

// WorkerTransport returns the worker's current transport, read under the
// registry lock so it cannot race with MarkWorkerOffline's Transport=nil
// write when the worker disconnects mid-use. The returned transport is a
// snapshot: it may already be closed — callers must still check IsClosed
// (or handle the resulting stream errors).
func (r *Registry) WorkerTransport(workerID string) (*tunnel.MuxTransport, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	w, exists := r.workers[workerID]
	if !exists {
		return nil, false
	}
	return w.Transport, true
}

// ListWorkers returns a snapshot of all workers currently registered.
//
// Prefer Summaries: the pointers this returns expose mutable fields (Status,
// Transport) that other goroutines mutate under the registry lock, so every
// field read through them is a data race. Kept for existing callers.
func (r *Registry) ListWorkers() []*Worker {
	r.mu.RLock()
	defer r.mu.RUnlock()

	list := make([]*Worker, 0, len(r.workers))
	for _, w := range r.workers {
		list = append(list, w)
	}
	return list
}

// WorkerSummary is a race-free value copy of one registry entry. Online is
// computed UNDER the registry lock (Status=="online" plus a non-nil,
// not-yet-closed transport), so it can never observe the mid-transition
// states that unlocked Worker-field reads race against.
type WorkerSummary struct {
	ID     string
	Online bool
}

// Summaries returns value copies of every registered worker, sorted by ID.
// It is the race-safe enumeration surface for fleet-wide consumers: unlike
// ListWorkers it hands out copies, not pointers into live registry state.
func (r *Registry) Summaries() []WorkerSummary {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]WorkerSummary, 0, len(r.workers))
	for id, w := range r.workers {
		out = append(out, WorkerSummary{
			ID:     id,
			Online: w.Status == "online" && w.Transport != nil && !w.Transport.IsClosed(),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Generation returns the current membership/liveness generation. See the gen
// field comment: it changes exactly when the set of registered/online workers
// changes, and is the cache-invalidation signal for the fleet-status rollup.
func (r *Registry) Generation() uint64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.gen
}
