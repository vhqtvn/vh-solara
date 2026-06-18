package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var healthCmd = &cobra.Command{
	Use:   "health",
	Short: "Print local health/debug info",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("Health OK")
	},
}

func init() {
	rootCmd.AddCommand(healthCmd)
}
