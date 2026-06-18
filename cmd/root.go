package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "vh-solara",
	Short: "Centralized remote control for OpenCode sessions",
	Long:  `vh-solara is a unified binary for managing and proxying OpenCode sessions across remote worker nodes.`,
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func init() {
	// Add subcommands here
}
