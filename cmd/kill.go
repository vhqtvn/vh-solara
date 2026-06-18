package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/spf13/cobra"
)

var killForce bool

var killCmd = &cobra.Command{
	Use:   "kill",
	Short: "Stop all local vh daemons and the OpenCode instances they own (global)",
	Long: "Globally stops every vh client-daemon registered on this machine and any\n" +
		"detached OpenCode instances they spawned (the survivable --opencode-detached\n" +
		"ones). Not scoped to the current directory.",
	RunE: func(cmd *cobra.Command, args []string) error {
		out := cmd.OutOrStdout()

		// Daemons first (so they don't reconnect/respawn), then owned OpenCode.
		daemons := killAll(daemonStateDir(), killForce, func(b []byte) int {
			var s daemonState
			if json.Unmarshal(b, &s) == nil {
				return s.PID
			}
			return 0
		})
		// Give daemons a moment to exit before reaping their (detached) OpenCode.
		if daemons > 0 {
			time.Sleep(400 * time.Millisecond)
		}
		opencodes := killAll(ocStateDir(), killForce, func(b []byte) int {
			var s ocState
			if json.Unmarshal(b, &s) == nil {
				return s.PID
			}
			return 0
		})

		fmt.Fprintf(out, "Stopped %d vh daemon(s) and %d OpenCode instance(s).\n", daemons, opencodes)
		return nil
	},
}

// killAll signals every live pid recorded in dir's *.json state files and
// removes the files. Returns how many live processes it signaled.
func killAll(dir string, force bool, pidOf func([]byte) int) int {
	files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	n := 0
	sig := syscall.SIGTERM
	if force {
		sig = syscall.SIGKILL
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err == nil {
			if pid := pidOf(b); pid > 0 && ocProcessAlive(pid) {
				if p, e := os.FindProcess(pid); e == nil && p.Signal(sig) == nil {
					n++
				}
			}
		}
		_ = os.Remove(f)
	}
	return n
}

func init() {
	killCmd.Flags().BoolVar(&killForce, "force", false, "use SIGKILL instead of SIGTERM")
	rootCmd.AddCommand(killCmd)
}
