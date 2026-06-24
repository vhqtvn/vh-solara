package alerts

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Web Push (closed-app delivery). When the PWA is fully closed there is no
// browser to receive an in-app notice, so the daemon pushes through the
// browser's push service (RFC 8030) with a VAPID-signed request (RFC 8292) and
// an RFC 8291 (aes128gcm) encrypted payload — all on the standard library.
//
// Push is the "reach me while I'm away" path: it fires only when no device is
// attending and the subscription's scope isn't off, so an actively-used session
// (which already gets in-app + OS notifications) isn't doubled up.

// vapidSubject is the contact the push service sees (RFC 8292 requires a sub).
const vapidSubject = "mailto:vh-solara@localhost"

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// b64urlDecode tolerates padded or unpadded base64url (browsers send unpadded).
func b64urlDecode(s string) ([]byte, error) {
	if b, err := base64.RawURLEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.URLEncoding.DecodeString(s)
}

// PushSub is one device's browser push subscription plus its delivery scope.
type PushSub struct {
	DeviceID string `json:"deviceId"`
	Endpoint string `json:"endpoint"`
	P256dh   string `json:"p256dh"` // client public key (base64url)
	Auth     string `json:"auth"`   // client auth secret (base64url)
	Scope    string `json:"scope"`  // off | current | all
}

// Pusher holds the VAPID identity, the subscription registry, and sends pushes.
type Pusher struct {
	cfg      *Store
	presence *Presence
	client   *http.Client
	now      func() time.Time

	vapidPriv *ecdsa.PrivateKey
	vapidPub  string // uncompressed public point, base64url (the applicationServerKey)

	mu       sync.Mutex
	subs     map[string]PushSub // deviceID -> subscription
	subsPath string
	cool     map[string]time.Time
}

// NewPusher loads (or creates) the VAPID key and subscription registry under
// stateDir. A non-nil error means push is unavailable; the rest of alerts works.
func NewPusher(cfg *Store, presence *Presence, stateDir string) (*Pusher, error) {
	priv, pub, err := loadOrCreateVAPID(filepath.Join(stateDir, "vapid.json"))
	if err != nil {
		return nil, err
	}
	p := &Pusher{
		cfg:      cfg,
		presence: presence,
		client:   &http.Client{Timeout: 10 * time.Second},
		now:      time.Now,
		vapidPriv: priv,
		vapidPub:  pub,
		subs:     map[string]PushSub{},
		subsPath: filepath.Join(stateDir, "push-subs.json"),
		cool:     map[string]time.Time{},
	}
	p.loadSubs()
	return p, nil
}

// PublicKey returns the VAPID application-server key (base64url) for clients to
// subscribe with.
func (p *Pusher) PublicKey() string { return p.vapidPub }

// Subscribe records/updates a device's push subscription.
func (p *Pusher) Subscribe(s PushSub) error {
	if s.DeviceID == "" || s.Endpoint == "" || s.P256dh == "" || s.Auth == "" {
		return fmt.Errorf("incomplete subscription")
	}
	p.mu.Lock()
	p.subs[s.DeviceID] = s
	p.mu.Unlock()
	return p.persist()
}

// Unsubscribe removes a device's subscription.
func (p *Pusher) Unsubscribe(deviceID string) error {
	p.mu.Lock()
	delete(p.subs, deviceID)
	p.mu.Unlock()
	return p.persist()
}

// Count returns the number of stored subscriptions (for status/UI).
func (p *Pusher) Count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.subs)
}

// Send delivers a notice to eligible subscriptions. Gating: the active profile
// must want the type, no device may be attending (push is the away path), and
// the subscription's scope must not be off. Non-blocking.
func (p *Pusher) Send(n Notice) {
	cfg := p.cfg.Get()
	prof := cfg.ActiveProfile()
	if !prof.wantsType(n.Type) {
		return
	}
	if p.presence.Attended(time.Duration(cfg.Detect.IdleSec) * time.Second) {
		return // someone's here — the open app handles delivery
	}
	cooldown := time.Duration(cfg.Detect.CooldownSec) * time.Second
	payload, _ := json.Marshal(n)

	p.mu.Lock()
	subs := make([]PushSub, 0, len(p.subs))
	for _, s := range p.subs {
		subs = append(subs, s)
	}
	p.mu.Unlock()

	for _, s := range subs {
		if s.Scope == ScopeOff {
			continue
		}
		if p.onCooldown(n.Type, s.DeviceID, cooldown) {
			continue
		}
		go p.deliver(s, payload)
	}
}

func (p *Pusher) onCooldown(typ, device string, window time.Duration) bool {
	if window <= 0 {
		return false
	}
	key := typ + "|" + device
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	if last, ok := p.cool[key]; ok && now.Sub(last) < window {
		return true
	}
	p.cool[key] = now
	return false
}

// deliver encrypts the payload for one subscription and POSTs it. A 404/410
// means the subscription is gone — drop it.
func (p *Pusher) deliver(s PushSub, payload []byte) {
	uaPub, err := b64urlDecode(s.P256dh)
	if err != nil {
		return
	}
	auth, err := b64urlDecode(s.Auth)
	if err != nil {
		return
	}
	body, err := encryptPush(payload, uaPub, auth)
	if err != nil {
		return
	}
	auth_hdr, err := p.vapidAuth(s.Endpoint)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.Endpoint, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("TTL", "86400")
	req.Header.Set("Urgency", "normal")
	req.Header.Set("Authorization", auth_hdr)
	resp, err := p.client.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
		_ = p.Unsubscribe(s.DeviceID) // subscription expired
	}
}

// vapidAuth builds the "Authorization: vapid t=<jwt>, k=<pubkey>" header for an
// endpoint (RFC 8292), signing an ES256 JWT scoped to the endpoint's origin.
func (p *Pusher) vapidAuth(endpoint string) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", err
	}
	aud := u.Scheme + "://" + u.Host
	header := b64url([]byte(`{"typ":"JWT","alg":"ES256"}`))
	claims, _ := json.Marshal(map[string]any{
		"aud": aud,
		"exp": p.now().Add(12 * time.Hour).Unix(),
		"sub": vapidSubject,
	})
	signingInput := header + "." + b64url(claims)
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, p.vapidPriv, digest[:])
	if err != nil {
		return "", err
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	jwt := signingInput + "." + b64url(sig)
	return "vapid t=" + jwt + ", k=" + p.vapidPub, nil
}

// --- RFC 8291 encryption (aes128gcm) ---

// encryptPush encrypts plaintext for a subscription using a fresh salt and
// ephemeral key. The returned body is the full aes128gcm content-coding (header
// + ciphertext), ready as the request body.
func encryptPush(plaintext, uaPublic, authSecret []byte) ([]byte, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	asPriv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return encryptPushWith(plaintext, uaPublic, authSecret, salt, asPriv)
}

// encryptPushWith is the deterministic core (salt + ephemeral key injected) so
// it can be tested against fixed vectors.
func encryptPushWith(plaintext, uaPublic, authSecret, salt []byte, asPriv *ecdh.PrivateKey) ([]byte, error) {
	uaPub, err := ecdh.P256().NewPublicKey(uaPublic)
	if err != nil {
		return nil, fmt.Errorf("bad client key: %w", err)
	}
	asPubBytes := asPriv.PublicKey().Bytes() // 65-byte uncompressed point
	shared, err := asPriv.ECDH(uaPub)
	if err != nil {
		return nil, err
	}

	// RFC 8291 §3.4: derive the input keying material from the ECDH secret,
	// authenticated by the subscription's auth secret.
	keyInfo := append([]byte("WebPush: info\x00"), uaPublic...)
	keyInfo = append(keyInfo, asPubBytes...)
	ikm, err := hkdf.Key(sha256.New, shared, authSecret, string(keyInfo), 32)
	if err != nil {
		return nil, err
	}

	// RFC 8188: content-encryption key + nonce from the per-message salt.
	prk, err := hkdf.Extract(sha256.New, ikm, salt)
	if err != nil {
		return nil, err
	}
	cek, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: aes128gcm\x00", 16)
	if err != nil {
		return nil, err
	}
	nonce, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: nonce\x00", 12)
	if err != nil {
		return nil, err
	}

	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	// Single record: append the 0x02 "last record" padding delimiter.
	record := append(append([]byte{}, plaintext...), 0x02)
	ciphertext := gcm.Seal(nil, nonce, record, nil)

	// Header: salt(16) | record_size(4) | idlen(1) | keyid(=as_public).
	rs := uint32(4096)
	if int(rs) < len(ciphertext) {
		rs = uint32(len(ciphertext))
	}
	var buf bytes.Buffer
	buf.Write(salt)
	_ = binary.Write(&buf, binary.BigEndian, rs)
	buf.WriteByte(byte(len(asPubBytes)))
	buf.Write(asPubBytes)
	buf.Write(ciphertext)
	return buf.Bytes(), nil
}

// --- VAPID key persistence ---

type vapidFile struct {
	PrivatePKCS8 string `json:"private_pkcs8"` // base64
	PublicKey    string `json:"public_key"`    // base64url, uncompressed point
}

func loadOrCreateVAPID(path string) (*ecdsa.PrivateKey, string, error) {
	if raw, err := os.ReadFile(path); err == nil {
		var vf vapidFile
		if json.Unmarshal(raw, &vf) == nil {
			der, derr := base64.StdEncoding.DecodeString(vf.PrivatePKCS8)
			if derr == nil {
				if key, perr := x509.ParsePKCS8PrivateKey(der); perr == nil {
					if ec, ok := key.(*ecdsa.PrivateKey); ok {
						return ec, vf.PublicKey, nil
					}
				}
			}
		}
		// fall through to regenerate on a corrupt file
	}
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, "", err
	}
	pub, err := vapidPublicB64(priv)
	if err != nil {
		return nil, "", err
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, "", err
	}
	vf := vapidFile{PrivatePKCS8: base64.StdEncoding.EncodeToString(der), PublicKey: pub}
	out, _ := json.MarshalIndent(vf, "", "  ")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, "", err
	}
	if err := os.WriteFile(path, out, 0o600); err != nil {
		return nil, "", err
	}
	return priv, pub, nil
}

// vapidPublicB64 renders an ECDSA public key as a base64url uncompressed point.
func vapidPublicB64(priv *ecdsa.PrivateKey) (string, error) {
	ecdhPub, err := priv.PublicKey.ECDH()
	if err != nil {
		return "", err
	}
	return b64url(ecdhPub.Bytes()), nil
}

// --- subscription persistence ---

func (p *Pusher) loadSubs() {
	raw, err := os.ReadFile(p.subsPath)
	if err != nil {
		return
	}
	var list []PushSub
	if json.Unmarshal(raw, &list) != nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, s := range list {
		if s.DeviceID != "" {
			p.subs[s.DeviceID] = s
		}
	}
}

func (p *Pusher) persist() error {
	p.mu.Lock()
	list := make([]PushSub, 0, len(p.subs))
	for _, s := range p.subs {
		list = append(list, s)
	}
	p.mu.Unlock()
	out, _ := json.MarshalIndent(list, "", "  ")
	if err := os.MkdirAll(filepath.Dir(p.subsPath), 0o700); err != nil {
		return err
	}
	tmp := p.subsPath + ".tmp"
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p.subsPath)
}
