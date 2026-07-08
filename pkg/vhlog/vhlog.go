// Package vhlog is a tiny structured-logging helper shared by the aggregator
// and web server. It wraps log/slog with a single env toggle so debug tracing
// (per-event, per-request) can be turned on in the field without a rebuild:
//
//	VH_DEBUG=1   # or "true"/"debug"/"yes"
//
// Without it, only Info/Warn/Error are emitted; Debug is dropped. Output goes to
// stderr alongside the daemon's existing log.Printf lines.
//
// A local debug-configured binary (see `make build-debug`) forces debug on at
// build time via ldflags, so VH_DEBUG=1 isn't needed; the env var still wins.
package vhlog

import (
	"log/slog"
	"os"
	"strings"
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

var logger = func() *slog.Logger {
	level := slog.LevelInfo
	if debugOn {
		level = slog.LevelDebug
	}
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
}()

// Enabled reports whether debug logging is on. Use it to guard expensive
// argument construction before a Debug call.
func Enabled() bool { return debugOn }

func Debug(msg string, args ...any) { logger.Debug(msg, args...) }
func Info(msg string, args ...any)  { logger.Info(msg, args...) }
func Warn(msg string, args ...any)  { logger.Warn(msg, args...) }
func Error(msg string, args ...any) { logger.Error(msg, args...) }
