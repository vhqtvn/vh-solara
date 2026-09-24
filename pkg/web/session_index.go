package web

import (
	"context"
	"log"
	"os"
	"strings"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// sessionIndexDisableEnv turns the OpenCode session-list index converge off
// entirely (operator escape hatch), e.g. VH_DISABLE_SESSION_INDEX=1.
const sessionIndexDisableEnv = "VH_DISABLE_SESSION_INDEX"

// EnableSessionListIndex opts this server into converging OpenCode's
// session-list index (opencode.EnsureSessionListIndex) every time the default
// aggregator (re)attaches to OpenCode. The daemons call it; tests do not, so a
// test run never touches a developer's real OpenCode DB. Call before the
// default aggregator's Run starts.
func (s *Server) EnableSessionListIndex() {
	if v := strings.TrimSpace(os.Getenv(sessionIndexDisableEnv)); v != "" && v != "0" {
		log.Printf("[opencode-index] session-list index converge disabled via %s", sessionIndexDisableEnv)
		return
	}
	s.agg.SetOnConnected(s.convergeSessionListIndex)
}

// convergeSessionListIndex runs the converge off the aggregator's Run goroutine
// (the onConnected contract forbids blocking). Non-fatal by design: any failure
// is logged and retried on the next (re)attach.
func (s *Server) convergeSessionListIndex() {
	go func() {
		ctx, cancel := context.WithTimeout(s.bgCtx, 45*time.Second)
		defer cancel()
		act, err := opencode.EnsureSessionListIndex(ctx, s.externalOC)
		if err != nil {
			log.Printf("[opencode-index] session-list index converge failed (non-fatal, retried on next attach): %v", err)
			return
		}
		log.Printf("[opencode-index] session-list index: %s", act)
	}()
}
