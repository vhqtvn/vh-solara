# Paseo — security & relay (remote-access)
Pin: 9e5accee (base, verified; crypto UNCHANGED at HEAD). Source: local clone refs/paseo @ 9e5accee.
See delta-d9b72e1-to-5d15e40.md for the relay OPT-IN policy change (crypto untouched).

## Threat model (SECURITY.md)
- **Relay operator** (Cloudflare Worker front → Elixir on Fly.io): full control of relay infra; observes traffic, can drop/reorder/replay/inject; knows IPs/timing/sizes/serverIds + the 2 plaintext public-key handshake frames. CANNOT decrypt payload, forge an E2EE msg, or impersonate the daemon.
- **Network attacker:** passive sniff + active MITM on TLS legs + DNS-rebinding vs a direct loopback daemon. CANNOT break TLS or decrypt E2EE even if a TLS leg falls.
- **Local:** socket-reachability = trust (Docker-HOST model). Agents fully trusted (no per-agent sandbox).

## E2EE crypto (`packages/relay/src/crypto.ts`, tweetnacl)
- Key exchange: X25519 ECDH (`nacl.box.keyPair` + `nacl.box.before`). AEAD: **XSalsa20-Poly1305** (`nacl.box.after`, precomputed-shared-key form). Nonce: 24-byte RANDOM per message. Bundle `[24-byte nonce ‖ ciphertext]`, base64 transport.
- **Daemon identity keypair:** persistent Curve25519 at `$PASEO_HOME/daemon-keypair.json` (`{v:2, publicKeyB64, secretKeyB64}`, Zod), mode **0600**, regenerated if corrupt (`daemon-keypair.ts:loadOrCreateDaemonKeyPair`).
- **Client keypair:** EPHEMERAL, per-session, never persisted.
- **Pairing QR/offer URL fragment** carries daemon PUBLIC key only (`encodeOfferToFragmentUrl` → `https://app.paseo.sh/#offer=<base64url>`; fragment never sent to the hosted SPA server → app.paseo.sh never sees the key).
- **E2EE handshake:** client sends plaintext `{type:"e2ee_hello", key:<clientPubKeyB64>}`; daemon replies plaintext `{type:"e2ee_ready"}`; all subsequent frames ciphertext.
- **Re-key guard:** daemon sees a different client key after open → close `1008 "E2EE re-handshake key mismatch"`.

## Relay topology (LIVE)
- Cloudflare Worker is a **cutover-proxy** (`cutover-proxy.ts`) to an **Elixir service on Fly.io** (`paseo-relay-next.fly.dev`, `wrangler.toml:PASEO_RELAY_UPSTREAM`). The in-repo `RelayDurableObject` TS code is BYPASSED → **Elixir backend unauditable from this repo.** Zero-knowledge byte router (forwards ciphertext + the 2 public-key handshake frames verbatim; never decrypts).

## DNS-rebinding defense
- **Host-header allowlist** (`hostnames.ts:isHostnameAllowed`): `true`=disable (footgun); `[]`/undefined=defaults (localhost, *.localhost, any IP); `[...]`=those + defaults; leading `.` matches domain + subdomains. Config `daemon.hostnames` (legacy `allowedHosts`); env `PASEO_HOSTNAMES`.
- Secondary: WS same-origin (`websocket-server.ts:isWebSocketSameOrigin` — both origin + requestHost must be loopback aliases). Bearer WS subprotocol. Download single-use 60s tokens (`/api/files/download`).

## Auth (`auth.ts`)
- Open local (no password) OR **bcrypt(12) password sent as RAW BEARER every request** (HTTP `Authorization: Bearer <pw>`; WS subprotocol `paseo.bearer.<pw>` since browser WS can't set headers). NO session token/refresh. Bypass paths: OPTIONS, `/api/health`, `/api/files/download` (single-use token), `/mcp/agents` (per-daemon-run capability token via `timingSafeEqual` OR bearer).

## Sharp edges (documented + inferred)
- **NO within-session replay protection** — random nonces, no counters/MAC. Relay/attacker can replay a captured ciphertext; MAC still verifies. (Documented limitation.)
- Bearer token = raw password on every request (safe only under TLS/E2EE).
- Elixir relay backend unauditable.
- `daemon.hostnames: true` silently disables the DNS-rebinding check.
- **No public-key fingerprint confirmation at first pairing** — MITM at first pairing bounded only by QR authenticity (subsequent sessions safe via re-key guard).
- Agents fully trusted (inherit daemon creds/fs; no per-agent jail).
- Plaintext relay code path exists when `daemonKeyPair` undefined (not default).

## vh-solara relevance
- Directly applicable to vh-solara's tunnel/edge security: the E2EE-over-untrusted-relay design, DNS-rebinding Host-header defense, and bearer/subprotocol auth are all reference-grade for the yamux star topology (note: vh-solara's controller multiplexes; paseo's relay bridges one daemon — different control planes, same crypto lessons).
