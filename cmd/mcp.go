package cmd

import (
	"log"
	"os"

	"github.com/spf13/cobra"
	"github.com/vhqtvn/vh-solara/pkg/mcp"
)

var (
	mcpBaseURL string
	mcpToken   string
	mcpWorker  string
	mcpLocal   bool
	mcpSock    string
)

var mcpCmd = &cobra.Command{
	Use:   "mcp",
	Short: "Run an MCP (stdio) facade over the cross-worker coordination API",
	Long: `Exposes vh-solara's read + write verbs as MCP tools over stdio, so an
opencode agent can drive sessions across machines natively. It is an HTTP client
of a controller's /api/workers/* API; configure it as an MCP server command in
opencode (type: local).`,
	Run: func(cmd *cobra.Command, args []string) {
		if v := os.Getenv("VH_API_TOKEN"); v != "" && mcpToken == "" {
			mcpToken = v
		}
		if v := os.Getenv("VH_CONTROLLER_URL"); v != "" && mcpBaseURL == "" {
			mcpBaseURL = v
		}
		// A socket path implies local mode over AF_UNIX (dial the worker's /vh/*).
		if mcpSock != "" {
			mcpLocal = true
		}
		// Default base URL per mode: unix → placeholder host (dialer ignores it);
		// local → a local --web vh server; controller → the controller edge.
		if mcpBaseURL == "" {
			switch {
			case mcpSock != "":
				mcpBaseURL = "http://unix"
			case mcpLocal:
				mcpBaseURL = "http://127.0.0.1:7700"
			default:
				mcpBaseURL = "http://127.0.0.1:8080"
			}
		}
		srv := mcp.New(mcpBaseURL, mcpToken, mcpWorker, Version)
		srv.Local = mcpLocal
		if mcpSock != "" {
			srv.HTTP = mcp.UnixClient(mcpSock)
		}
		// stdout carries the JSON-RPC stream; logs must go to stderr only.
		log.SetOutput(os.Stderr)
		if err := srv.Serve(os.Stdin, os.Stdout); err != nil {
			log.Fatalf("mcp server: %v", err)
		}
	},
}

func init() {
	mcpCmd.Flags().BoolVar(&mcpLocal, "local", false, "Local mode: drive a local --web vh server's /vh/* directly (no controller, no bearer). Default base-url http://127.0.0.1:7700")
	mcpCmd.Flags().StringVar(&mcpBaseURL, "base-url", "", "Base URL: a local vh server (--local) or a controller (or VH_CONTROLLER_URL)")
	mcpCmd.Flags().StringVar(&mcpToken, "token", "", "Bearer token for the controller coordination API (or VH_API_TOKEN); unused in --local")
	mcpCmd.Flags().StringVar(&mcpWorker, "worker", "", "Controller mode: default worker id when a tool call omits 'worker'")
	mcpCmd.Flags().StringVar(&mcpSock, "sock", "", "Local mode over an AF_UNIX socket: dial the worker's /vh/* at this socket path (no TCP, no port discovery). Implies --local.")
	rootCmd.AddCommand(mcpCmd)
}
