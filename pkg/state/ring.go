package state

// ringBuffer retains the most recent client events for resume-via-replay.
// Events are pushed in strictly increasing seq order.
//
// It is a true fixed-capacity ring: the backing array is allocated once at
// construction and push is O(1) (write in place + advance a modular head),
// never reallocating or copying the retained events even once the buffer is
// full. The logical (oldest->newest) order is reconstructed on read by since().
type ringBuffer struct {
	cap   int           // fixed capacity; len(items) == cap
	head  int           // index where the NEXT push writes
	count int           // number of valid entries (saturates at cap)
	items []ClientEvent // fixed-length backing array, len == cap
}

func newRingBuffer(capacity int) *ringBuffer {
	if capacity < 1 {
		capacity = 1
	}
	return &ringBuffer{
		cap:   capacity,
		items: make([]ClientEvent, capacity),
	}
}

// push appends ev in O(1): it writes into the next slot and advances the
// modular head, overwriting the oldest entry once the buffer is full. No
// allocation and no copy of retained events occur on the hot path.
func (r *ringBuffer) push(ev ClientEvent) {
	r.items[r.head] = ev
	r.head++
	if r.head == r.cap {
		r.head = 0
	}
	if r.count < r.cap {
		r.count++
	}
}

// oldestIndex returns the array slot currently holding the logically oldest
// retained entry. While the buffer has never overflowed (count < cap) that is
// slot 0; once full, head points at the oldest entry (the next push overwrites
// it, making it the soonest-evicted, i.e. the oldest).
func (r *ringBuffer) oldestIndex() int {
	if r.count < r.cap {
		return 0
	}
	return r.head
}

// since returns events with seq > cursor. ok is false when the cursor is older
// than the oldest retained event (a gap exists, so a snapshot is required).
// The returned slice is in insertion order (oldest -> newest).
func (r *ringBuffer) since(cursor, head uint64) (events []ClientEvent, _ uint64, ok bool) {
	if cursor >= head {
		return nil, head, true // client is current
	}
	if r.count == 0 {
		return nil, head, false
	}
	oldest := r.oldestIndex()
	if cursor+1 < r.items[oldest].Seq {
		return nil, head, false // gap: dropped events between cursor and buffer
	}
	// Walk the valid entries in logical (oldest -> newest) order. While not yet
	// full this is a plain items[0:count] scan; once full it wraps from head
	// around to head-1. The modular index expresses both uniformly.
	for i := 0; i < r.count; i++ {
		ev := r.items[(oldest+i)%r.cap]
		if ev.Seq > cursor {
			events = append(events, ev)
		}
	}
	return events, head, true
}
