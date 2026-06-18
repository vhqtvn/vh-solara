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
		if mcpBaseURL == "" {
			mcpBaseURL = "http://127.0.0.1:8080"
		}
		srv := mcp.New(mcpBaseURL, mcpToken, mcpWorker, Version)
		// stdout carries the JSON-RPC stream; logs must go to stderr only.
		log.SetOutput(os.Stderr)
		if err := srv.Serve(os.Stdin, os.Stdout); err != nil {
			log.Fatalf("mcp server: %v", err)
		}
	},
}

func init() {
	mcpCmd.Flags().StringVar(&mcpBaseURL, "base-url", "", "Controller base URL (or VH_CONTROLLER_URL; default http://127.0.0.1:8080)")
	mcpCmd.Flags().StringVar(&mcpToken, "token", "", "Bearer token for the coordination API (or VH_API_TOKEN)")
	mcpCmd.Flags().StringVar(&mcpWorker, "worker", "", "Default worker id used when a tool call omits 'worker'")
	rootCmd.AddCommand(mcpCmd)
}
