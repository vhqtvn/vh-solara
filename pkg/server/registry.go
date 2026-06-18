package server

import (
	"fmt"
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
	}
}

// CleanupOfflineWorkers removes all workers that are currently marked as offline.
func (r *Registry) CleanupOfflineWorkers() {
	r.mu.Lock()
	defer r.mu.Unlock()

	for id, w := range r.workers {
		if w.Status == "offline" {
			delete(r.workers, id)
		}
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

// ListWorkers returns a snapshot of all workers currently registered.
func (r *Registry) ListWorkers() []*Worker {
	r.mu.RLock()
	defer r.mu.RUnlock()

	list := make([]*Worker, 0, len(r.workers))
	for _, w := range r.workers {
		list = append(list, w)
	}
	return list
}
