package cmd

import (
	"log"
	"os"

	"github.com/spf13/cobra"
	"github.com/vhqtvn/vh-solara/pkg/server"
)

var serverAddr string
var daemonAddr string
var hostPattern string
var serverAuth authFlags
var serverWorkerSecret string

var serverCmd = &cobra.Command{
	Use:   "server",
	Short: "Run the central controller server",
	Run: func(cmd *cobra.Command, args []string) {
		daemon := server.NewDaemon(serverAddr, daemonAddr, hostPattern)
		a, err := buildAuth(serverAddr, &serverAuth)
		if err != nil {
			log.Fatalf("Auth setup failed: %v", err)
		}
		daemon.Auth = a
		daemon.RegSecret = serverWorkerSecret
		if v := os.Getenv("VH_WORKER_SECRET"); v != "" {
			daemon.RegSecret = v
		}
		if err := daemon.Start(); err != nil {
			log.Fatalf("Server failed: %v", err)
		}
	},
}

func init() {
	serverCmd.Flags().StringVarP(&serverAddr, "addr", "a", ":8080", "Server address to listen on for user connections")
	serverCmd.Flags().StringVarP(&daemonAddr, "daemon-addr", "d", ":8081", "Server address to listen on for agent daemon connections")
	serverCmd.Flags().StringVar(&hostPattern, "host-pattern", "", "Host template to extract/build worker URLs (e.g., '$ID.example.com')")
	serverCmd.Flags().StringVar(&serverWorkerSecret, "worker-secret", "", "Shared secret required from workers on registration via X-VH-Worker-Secret (prefer the VH_WORKER_SECRET env var); empty = open registration")
	registerAuthFlags(serverCmd, &serverAuth)
	rootCmd.AddCommand(serverCmd)
}
