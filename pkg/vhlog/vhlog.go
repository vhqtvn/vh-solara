// Package vhlog is a tiny structured-logging helper shared by the aggregator
// and web server. It wraps log/slog with a single env toggle so debug tracing
// (per-event, per-request) can be turned on in the field without a rebuild:
//
//	VH_DEBUG=1   # or "true"/"debug"/"yes"
//
// Without it, only Info/Warn/Error are emitted; Debug is dropped. Output goes to
// stderr alongside the daemon's existing log.Printf lines. Tests can capture
// that output by swapping the destination with SetOutput (process-wide;
// restore the returned previous writer afterwards).
//
// A local debug-configured binary (see `make build-debug`) forces debug on at
// build time via ldflags, so VH_DEBUG=1 isn't needed; the env var still wins.
package vhlog

import (
	"io"
	"log/slog"
	"os"
	"strings"
	"sync/atomic"
)

// debugForced is stamped to "1" via -ldflags for a local debug-configured
// build (see `make build-debug`) so debug tracing is on without VH_DEBUG=1.
// The VH_DEBUG env var still wins as an additional override.
var debugForced = "0"

var debugOn = parseEnabled(os.Getenv("VH_DEBUG")) || parseEnabled(debugForced)

func parseEnabled(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "debug", "yes", "on":
		return true
	}
	return false
}

// sink pairs the active logger with the writer it was built from, so
// SetOutput can hand back the writer a caller should restore.
type sink struct {
	logger *slog.Logger
	writer io.Writer
}

// newSink builds the sink for w under the package's single level policy
// (VH_DEBUG / build-forced debug) and default slog text format.
func newSink(w io.Writer) *sink {
	level := slog.LevelInfo
	if debugOn {
		level = slog.LevelDebug
	}
	return &sink{
		logger: slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{Level: level})),
		writer: w,
	}
}

// current holds the process-wide logging sink as an atomic pointer so
// SetOutput can swap it race-free while other goroutines log: every
// Debug/Info/Warn/Error call loads the current sink and uses it for that
// one record (a record racing a swap lands in the old or new destination,
// never a torn mix). init installs the default stderr sink.
var current atomic.Pointer[sink]

func init() { current.Store(newSink(os.Stderr)) }

// SetOutput swaps the process-wide log destination to w and returns the
// writer it replaced, so a caller — typically a test — can restore it:
//
//	prev := vhlog.SetOutput(&buf)
//	defer vhlog.SetOutput(prev)
//
// The swap affects the whole process. The rebuilt handler keeps the
// default format (slog text) and level policy (VH_DEBUG / build-forced
// debug); only the destination changes. Passing nil leaves the sink
// unchanged and returns the current writer. Swaps do not drain in-flight
// records and slog serializes per handler, not per writer, so a writer
// that may be shared by concurrent emitters across a swap (e.g.
// re-installed while a straggler goroutine still holds the old sink)
// must be safe for concurrent use.
func SetOutput(w io.Writer) io.Writer {
	if w == nil {
		return current.Load().writer
	}
	old := current.Swap(newSink(w))
	return old.writer
}

// Enabled reports whether debug logging is on. Use it to guard expensive
// argument construction before a Debug call.
func Enabled() bool { return debugOn }

// Logger returns the shared *slog.Logger for packages that need an
// injectable logger field (e.g. pkg/alerts' Notifier) while keeping the
// daemon's single logging configuration (one handler, one VH_DEBUG toggle).
// The returned logger is never nil. It is a snapshot of the current sink:
// its destination is fixed at call time, so a logger held across a
// SetOutput swap keeps writing to the previous destination.
func Logger() *slog.Logger { return current.Load().logger }

func Debug(msg string, args ...any) { current.Load().logger.Debug(msg, args...) }
func Info(msg string, args ...any)  { current.Load().logger.Info(msg, args...) }
func Warn(msg string, args ...any)  { current.Load().logger.Warn(msg, args...) }
func Error(msg string, args ...any) { current.Load().logger.Error(msg, args...) }
