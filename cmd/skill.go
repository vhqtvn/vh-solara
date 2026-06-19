package cmd

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
	"github.com/vhqtvn/vh-solara/pkg/skill"
)

var (
	skillRepo string
	skillOut  string
)

var skillCmd = &cobra.Command{
	Use:   "skill",
	Short: "Emit/install the version-synced 'how to drive vh-solara' client skill",
	Long: `vh-solara owns the agent-facing client surface (verb shapes, gate{} facts, UDS
usage, the streaming/cursor + status contract). This generates that skill from the
running binary's surface — version-stamped, so a consuming repo installs it rather
than maintaining a copy that drifts.`,
}

var skillEmitCmd = &cobra.Command{
	Use:   "emit",
	Short: "Write the generated SKILL.md to stdout (diff/CI-check against an installed copy)",
	RunE: func(cmd *cobra.Command, args []string) error {
		_, err := fmt.Fprint(cmd.OutOrStdout(), skill.Generate(Version))
		return err
	},
}

var skillInstallCmd = &cobra.Command{
	Use:   "install",
	Short: "Provision the generated SKILL.md into a repo (idempotent; overwrites on upgrade)",
	RunE: func(cmd *cobra.Command, args []string) error {
		dir := filepath.Join(skillRepo, skillOut)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("create skill dir: %w", err)
		}
		path := filepath.Join(dir, "SKILL.md")
		if err := os.WriteFile(path, []byte(skill.Generate(Version)), 0o644); err != nil {
			return err
		}
		fmt.Fprintf(cmd.OutOrStdout(), "installed vh-solara client skill (%s) → %s\n", Version, path)
		return nil
	},
}

func init() {
	skillInstallCmd.Flags().StringVar(&skillRepo, "repo", ".", "Target repo directory")
	skillInstallCmd.Flags().StringVar(&skillOut, "out", skill.DefaultInstallDir, "Install location within the repo (a SKILL.md is written here)")
	skillCmd.AddCommand(skillEmitCmd)
	skillCmd.AddCommand(skillInstallCmd)
	rootCmd.AddCommand(skillCmd)
}
