package state

// ringBuffer retains the most recent client events for resume-via-replay.
// Events are pushed in strictly increasing seq order.
type ringBuffer struct {
	cap   int
	items []ClientEvent
}

func newRingBuffer(capacity int) *ringBuffer {
	if capacity < 1 {
		capacity = 1
	}
	return &ringBuffer{cap: capacity}
}

func (r *ringBuffer) push(ev ClientEvent) {
	r.items = append(r.items, ev)
	if len(r.items) > r.cap {
		// Drop from the front; copy to avoid unbounded backing-array growth.
		drop := len(r.items) - r.cap
		r.items = append([]ClientEvent(nil), r.items[drop:]...)
	}
}

// since returns events with seq > cursor. ok is false when the cursor is older
// than the oldest retained event (a gap exists, so a snapshot is required).
func (r *ringBuffer) since(cursor, head uint64) (events []ClientEvent, _ uint64, ok bool) {
	if cursor >= head {
		return nil, head, true // client is current
	}
	if len(r.items) == 0 {
		return nil, head, false
	}
	if cursor+1 < r.items[0].Seq {
		return nil, head, false // gap: dropped events between cursor and buffer
	}
	for _, ev := range r.items {
		if ev.Seq > cursor {
			events = append(events, ev)
		}
	}
	return events, head, true
}
