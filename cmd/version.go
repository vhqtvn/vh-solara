package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

// Version is stamped at build time via
//
//	-ldflags "-X github.com/vhqtvn/vh-solara/cmd.Version=v3.0.0"
//
// Release builds stamp the bare tag (see .github/workflows/release.yml); local
// Makefile builds stamp "<latest v-tag>+dev" (see the Makefile's VERSION).
// Defaults to "dev" for plain `go build`.
var Version = "dev"

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print version/build info",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("vh-solara " + Version)
	},
}

func init() {
	rootCmd.AddCommand(versionCmd)
}
