package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

// Version is stamped at build time via
//
//	-ldflags "-X github.com/vhqtvn/vh-solara/cmd.Version=v3.0.0"
//
// (see .github/workflows/release.yml). Defaults to "dev" for local builds.
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
