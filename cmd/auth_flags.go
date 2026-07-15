package cmd

import (
	"context"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/spf13/cobra"
	"github.com/vhqtvn/vh-solara/pkg/auth"
)

// authFlags holds the --auth-* flag values shared by the public-edge commands
// (controller, local-server). See docs/architecture/06-auth.md.
type authFlags struct {
	mode                 string
	oidcIssuer           string
	oidcClientID         string
	oidcClientSecret     string
	oidcRedirectURL      string
	allowedEmails        []string
	allowedDomains       []string
	passphrase           string
	trustProxyHeader     string
	cookieDomain         string
	cookieSecure         bool
	requireVerifiedEmail bool
}

// registerAuthFlags adds the --auth-* flags to a command.
func registerAuthFlags(cmd *cobra.Command, f *authFlags) {
	cmd.Flags().StringVar(&f.mode, "auth-mode", "none", "Auth mode: none|oidc|passphrase|trust-proxy (none is allowed on a loopback bind only)")
	cmd.Flags().StringVar(&f.oidcIssuer, "auth-oidc-issuer", "", "(oidc) Issuer URL, e.g. https://accounts.google.com")
	cmd.Flags().StringVar(&f.oidcClientID, "auth-oidc-client-id", "", "(oidc) OAuth client ID")
	cmd.Flags().StringVar(&f.oidcClientSecret, "auth-oidc-client-secret", "", "(oidc) OAuth client secret (prefer the VH_AUTH_OIDC_CLIENT_SECRET env var)")
	cmd.Flags().StringVar(&f.oidcRedirectURL, "auth-oidc-redirect-url", "", "(oidc) Absolute callback URL, e.g. https://app.example.com/auth/callback")
	cmd.Flags().StringSliceVar(&f.allowedEmails, "auth-allowed-emails", nil, "(oidc) Allowed email address (repeatable / comma-separated)")
	cmd.Flags().StringSliceVar(&f.allowedDomains, "auth-allowed-domains", nil, "(oidc) Allowed email domain (repeatable / comma-separated)")
	cmd.Flags().StringVar(&f.passphrase, "auth-passphrase", "", "(passphrase) Shared passphrase (prefer the VH_AUTH_PASSPHRASE env var)")
	cmd.Flags().StringVar(&f.trustProxyHeader, "auth-trust-proxy", "", "(trust-proxy) Identity header set by a fronting proxy, e.g. X-Forwarded-Email")
	cmd.Flags().StringVar(&f.cookieDomain, "auth-cookie-domain", "", "Session cookie domain; empty = host-only, .example.com = shared across worker subdomains")
	cmd.Flags().BoolVar(&f.cookieSecure, "auth-cookie-secure", true, "Set the Secure flag on the session cookie (disable only for plain-HTTP local testing)")
	cmd.Flags().BoolVar(&f.requireVerifiedEmail, "auth-require-verified-email", false, "(oidc) Require the provider to assert email_verified even when the email matches the allow-list (env: VH_AUTH_REQUIRE_VERIFIED_EMAIL)")
}

// config assembles an auth.Config, preferring env vars for secrets.
func (f *authFlags) config() auth.Config {
	secret := f.oidcClientSecret
	if v := os.Getenv("VH_AUTH_OIDC_CLIENT_SECRET"); v != "" {
		secret = v
	}
	pass := f.passphrase
	if v := os.Getenv("VH_AUTH_PASSPHRASE"); v != "" {
		pass = v
	}
	// Bool env: an explicit VH_AUTH_REQUIRE_VERIFIED_EMAIL overrides the flag
	// default (unset/empty → keep the flag value). Accepts strconv.ParseBool
	// values (true/false/1/0/T/F/...); an unparseable value is ignored.
	requireVerified := f.requireVerifiedEmail
	if v := os.Getenv("VH_AUTH_REQUIRE_VERIFIED_EMAIL"); v != "" {
		if parsed, err := strconv.ParseBool(v); err == nil {
			requireVerified = parsed
		}
	}
	return auth.Config{
		Mode:                 auth.Mode(f.mode),
		OIDCIssuer:           f.oidcIssuer,
		OIDCClientID:         f.oidcClientID,
		OIDCClientSecret:     secret,
		OIDCRedirectURL:      f.oidcRedirectURL,
		AllowedEmails:        f.allowedEmails,
		AllowedDomains:       f.allowedDomains,
		Passphrase:           pass,
		TrustProxyHeader:     f.trustProxyHeader,
		CookieDomain:         f.cookieDomain,
		Secure:               f.cookieSecure,
		RequireVerifiedEmail: requireVerified,
	}
}

// buildAuth constructs the Authenticator. An insecure bind (public + no auth) is
// logged as a loud warning rather than refused, so an expert fronting their own
// auth/TLS keeps the historical behavior; only a genuine auth-config error fails.
func buildAuth(addr string, f *authFlags) (*auth.Authenticator, error) {
	cfg := f.config()
	if warn := auth.CheckBindSafety(addr, cfg); warn != nil {
		log.Printf("WARNING: %v", warn)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return auth.New(ctx, cfg)
}
