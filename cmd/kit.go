package cmd

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
	"github.com/vhqtvn/vh-solara/pkg/kit"
)

var (
	kitRepo   string
	kitParams []string
)

var kitCmd = &cobra.Command{
	Use:   "kit",
	Short: "Provision template kits into a repo (engine + overlay layers)",
	Long: `vh-solara provisions a versioned template kit into a target repo. It ships no
kit content — kits are authored elsewhere. A kit has an engine layer (vh-managed;
updates overwrite, unless a file carries a vh:keep marker) and overlay layers
(consumer-owned; never clobbered).`,
}

var kitInstallCmd = &cobra.Command{
	Use:   "install <kit-dir>",
	Short: "Install/update a kit into --repo (idempotent)",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		params, err := parseParams(kitParams)
		if err != nil {
			return err
		}
		rep, err := kit.Install(args[0], kitRepo, params)
		if err != nil {
			return err
		}
		fmt.Printf("Installed kit %q v%s into %s\n", rep.Kit, rep.Version, kitRepo)
		fmt.Printf("  written:   %d\n", len(rep.Written))
		for _, f := range rep.Written {
			fmt.Printf("    + %s\n", f)
		}
		if len(rep.Preserved) > 0 {
			fmt.Printf("  preserved: %d (overlay files left untouched)\n", len(rep.Preserved))
			for _, f := range rep.Preserved {
				fmt.Printf("    = %s\n", f)
			}
		}
		if len(rep.Kept) > 0 {
			fmt.Printf("  kept:      %d (engine files with a vh:keep marker)\n", len(rep.Kept))
			for _, f := range rep.Kept {
				fmt.Printf("    ~ %s\n", f)
			}
		}
		return nil
	},
}

var kitStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show the kit installed in --repo (from its lockfile)",
	RunE: func(cmd *cobra.Command, args []string) error {
		l, err := kit.Status(kitRepo)
		if err != nil {
			return err
		}
		if l == nil {
			fmt.Printf("no kit installed in %s\n", kitRepo)
			return nil
		}
		fmt.Printf("kit %q v%s\n", l.Kit, l.Version)
		for name, files := range l.Layers {
			fmt.Printf("  layer %s: %d files\n", name, len(files))
		}
		if len(l.Parameters) > 0 {
			fmt.Printf("  parameters: %v\n", l.Parameters)
		}
		return nil
	},
}

func parseParams(kv []string) (map[string]string, error) {
	out := map[string]string{}
	for _, p := range kv {
		i := strings.IndexByte(p, '=')
		if i < 0 {
			return nil, fmt.Errorf("invalid --param %q (want key=value)", p)
		}
		out[p[:i]] = p[i+1:]
	}
	return out, nil
}

func init() {
	kitCmd.PersistentFlags().StringVar(&kitRepo, "repo", ".", "Target repo directory")
	kitInstallCmd.Flags().StringArrayVar(&kitParams, "param", nil, "Parameter as key=value (repeatable)")
	kitCmd.AddCommand(kitInstallCmd)
	kitCmd.AddCommand(kitStatusCmd)
	rootCmd.AddCommand(kitCmd)
}
