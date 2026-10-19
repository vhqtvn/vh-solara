package vhlog

import (
	"bytes"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
)

// lockedBuffer is a concurrency-safe io.Writer (bytes.Buffer alone is not),
// so the swap-race test's sinks can absorb records from several goroutines.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// TestSetOutputRedirectsWarn: swapping in a buffer must route Warn records
// there in the default text format, and the pre-swap writer must be the
// package default, os.Stderr.
func TestSetOutputRedirectsWarn(t *testing.T) {
	var buf bytes.Buffer
	prev := SetOutput(&buf)
	defer SetOutput(prev)

	if prev != io.Writer(os.Stderr) {
		t.Fatalf("default writer = %v, want os.Stderr", prev)
	}

	Warn("sink-hello", "key", "value")

	out := buf.String()
	for _, want := range []string{"level=WARN", "msg=sink-hello", "key=value"} {
		if !strings.Contains(out, want) {
			t.Errorf("captured output missing %q; got:\n%s", want, out)
		}
	}
}

// TestSetOutputReturnsPreviousWriter: each SetOutput returns the writer it
// replaced, enabling restore — records stay in the sink that was current
// when they were emitted.
func TestSetOutputReturnsPreviousWriter(t *testing.T) {
	first := &bytes.Buffer{}
	second := &bytes.Buffer{}
	prev := SetOutput(first)
	defer SetOutput(prev)

	Warn("first-line")
	if got := SetOutput(second); got != io.Writer(first) {
		t.Fatalf("SetOutput returned %v, want the first buffer", got)
	}
	Warn("second-line")

	if firstS, secondS := first.String(), second.String(); !strings.Contains(firstS, "first-line") || strings.Contains(firstS, "second-line") {
		t.Errorf("first buffer = %q, want only the pre-swap line", firstS)
	} else if !strings.Contains(secondS, "second-line") || strings.Contains(secondS, "first-line") {
		t.Errorf("second buffer = %q, want only the post-swap line", secondS)
	}
}

// TestSetOutputNilKeepsCurrentWriter: a nil swap is a read, not a
// destination change.
func TestSetOutputNilKeepsCurrentWriter(t *testing.T) {
	var buf bytes.Buffer
	prev := SetOutput(&buf)
	defer SetOutput(prev)

	if got := SetOutput(nil); got != io.Writer(&buf) {
		t.Fatalf("SetOutput(nil) = %v, want the current buffer", got)
	}
	Warn("still-buffered")
	if !strings.Contains(buf.String(), "still-buffered") {
		t.Errorf("output after nil swap = %q, want the Warn record", buf.String())
	}
}

// TestSetOutputConcurrentSwap: logging from several goroutines while
// another swaps sinks must be -race clean and must neither lose nor
// duplicate records — each record lands in exactly one sink.
func TestSetOutputConcurrentSwap(t *testing.T) {
	sinks := make([]*lockedBuffer, 4)
	for i := range sinks {
		sinks[i] = &lockedBuffer{}
	}
	prev := SetOutput(sinks[0])
	defer SetOutput(prev)

	const workers, perWorker = 4, 50
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < perWorker; j++ {
				Info("swap-race", "worker", i, "iter", j)
			}
		}(i)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for j := 0; j < 100; j++ {
			SetOutput(sinks[j%len(sinks)])
		}
	}()
	wg.Wait()

	total := 0
	for _, s := range sinks {
		total += strings.Count(s.String(), "swap-race")
	}
	if total != workers*perWorker {
		t.Errorf("captured %d records across sinks, want %d", total, workers*perWorker)
	}
}
