package cmd

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"
)

// Default upstream repo (Gitea API base). Overridable with --repo.
const defaultRepoAPI = "https://api.github.com/repos/vhqtvn/vh-solara"

var (
	updateRepo  string
	updateForce bool
	updateYes   bool
)

var updateCmd = &cobra.Command{
	Use:   "update",
	Short: "Download and install the latest release binary (verified by SHA256)",
	Long: "Checks the latest Gitea release, downloads the binary for this OS/arch,\n" +
		"verifies its SHA256 against the published checksums, and atomically replaces\n" +
		"the running executable. Restart the daemon afterwards to run the new version.",
	RunE: func(cmd *cobra.Command, args []string) error {
		return runUpdate(cmd.OutOrStdout())
	},
}

func init() {
	updateCmd.Flags().StringVar(&updateRepo, "repo", defaultRepoAPI, "GitHub repo API base URL")
	updateCmd.Flags().BoolVar(&updateForce, "force", false, "reinstall even if already on the latest version")
	updateCmd.Flags().BoolVar(&updateYes, "yes", false, "skip the confirmation prompt")
	rootCmd.AddCommand(updateCmd)
}

type ghAsset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
}
type ghRelease struct {
	TagName string    `json:"tag_name"`
	Assets  []ghAsset `json:"assets"`
}

func runUpdate(out io.Writer) error {
	client := &http.Client{Timeout: 60 * time.Second}

	rel, err := latestRelease(client, updateRepo)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "Current: %s   Latest: %s\n", Version, rel.TagName)
	if rel.TagName == Version && !updateForce {
		fmt.Fprintln(out, "Already up to date.")
		return nil
	}

	assetName := fmt.Sprintf("vh-solara-%s-%s", runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		assetName += ".exe"
	}
	asset := findAsset(rel.Assets, assetName)
	if asset == nil {
		return fmt.Errorf("no release asset %q for this platform in %s", assetName, rel.TagName)
	}

	if !updateYes {
		fmt.Fprintf(out, "Install %s (%s)? Restart the daemon afterwards to apply.\n", rel.TagName, assetName)
		fmt.Fprint(out, "Proceed? [y/N]: ")
		var ans string
		_, _ = fmt.Scanln(&ans)
		if !strings.EqualFold(strings.TrimSpace(ans), "y") {
			fmt.Fprintln(out, "Aborted.")
			return nil
		}
	}

	// Expected checksum from the release's SHA256SUMS asset.
	want, err := expectedSum(client, rel.Assets, assetName)
	if err != nil {
		return err
	}

	fmt.Fprintf(out, "Downloading %s…\n", assetName)
	data, err := download(client, asset.URL)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	got := hex.EncodeToString(sum[:])
	if want != "" && !strings.EqualFold(got, want) {
		return fmt.Errorf("checksum mismatch: got %s, expected %s", got, want)
	}
	if want == "" {
		return fmt.Errorf("no SHA256SUMS entry for %s; refusing to install unverified binary (use a release that publishes checksums)", assetName)
	}

	if err := replaceSelf(data); err != nil {
		return err
	}
	fmt.Fprintf(out, "Installed %s. Restart the daemon to apply (this restarts OpenCode; sessions are preserved).\n", rel.TagName)
	return nil
}

func latestRelease(c *http.Client, repoAPI string) (*ghRelease, error) {
	resp, err := c.Get(strings.TrimRight(repoAPI, "/") + "/releases/latest")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("release lookup failed: HTTP %d", resp.StatusCode)
	}
	var rel ghRelease
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return nil, err
	}
	if rel.TagName == "" {
		return nil, fmt.Errorf("no release found")
	}
	return &rel, nil
}

func findAsset(assets []ghAsset, name string) *ghAsset {
	for i := range assets {
		if assets[i].Name == name {
			return &assets[i]
		}
	}
	return nil
}

// expectedSum downloads SHA256SUMS and returns the hex digest for assetName.
func expectedSum(c *http.Client, assets []ghAsset, assetName string) (string, error) {
	sums := findAsset(assets, "SHA256SUMS")
	if sums == nil {
		return "", nil // no checksums published
	}
	body, err := download(c, sums.URL)
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(body), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == assetName {
			return f[0], nil
		}
	}
	return "", nil
}

func download(c *http.Client, url string) ([]byte, error) {
	resp, err := c.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download failed: HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 256<<20)) // 256 MiB ceiling
}

// replaceSelf swaps the running executable. It first tries an in-place atomic
// rename (sibling temp → rename); if the install dir isn't writable (e.g.
// root-owned /usr/local/bin), it falls back to `sudo install` (interactive).
func replaceSelf(data []byte) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}

	if err := replaceInPlace(exe, data); err == nil {
		return nil
	} else if !isPermission(err) || runtime.GOOS == "windows" {
		return err
	}

	// Permission denied → elevate.
	fmt.Printf("Need elevated permission to write %s; using sudo…\n", exe)
	return replaceWithSudo(exe, data)
}

func isPermission(err error) bool {
	return errors.Is(err, fs.ErrPermission) || errors.Is(err, syscall.EACCES) || errors.Is(err, syscall.EPERM)
}

func replaceInPlace(exe string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(exe), ".vh-solara-update-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o755); err != nil {
		return err
	}
	return os.Rename(tmpName, exe)
}

func replaceWithSudo(exe string, data []byte) error {
	if _, err := exec.LookPath("sudo"); err != nil {
		return fmt.Errorf("cannot write %s and sudo is unavailable: run the update with sufficient privileges", exe)
	}
	// Stage in a writable temp dir, then `sudo install` over the target.
	tmp, err := os.CreateTemp("", "vh-solara-update-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	tmp.Close()
	cmd := exec.Command("sudo", "install", "-m", "0755", tmpName, exe)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr // let sudo prompt
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("sudo install failed: %w", err)
	}
	return nil
}
