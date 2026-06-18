package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var netnsCmd = &cobra.Command{
	Use:   "netns",
	Short: "Inspect/create/debug the private network namespace",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("netns debug:")
	},
}

func init() {
	rootCmd.AddCommand(netnsCmd)
}
