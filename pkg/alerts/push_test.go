package alerts

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"path/filepath"
	"testing"
)

// TestPushRFC8291Vector pins our encryption to the published RFC 8291 §5 worked
// example: with its fixed salt and application-server key, we must reproduce the
// exact ciphertext byte-for-byte. This is the real interop guarantee (a browser
// push service decrypts per the same RFC) — stronger than a self round-trip.
func TestPushRFC8291Vector(t *testing.T) {
	dec := func(s string) []byte {
		b, err := base64.RawURLEncoding.DecodeString(s)
		if err != nil {
			t.Fatalf("decode %q: %v", s, err)
		}
		return b
	}
	plaintext := dec("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24")
	uaPublic := dec("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")
	asPriv := dec("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")
	auth := dec("BTBZMqHH6r4Tts7J_aSIgg")
	salt := dec("DGv6ra1nlYgDCS1FRnbzlw")
	want := "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"

	priv, err := ecdh.P256().NewPrivateKey(asPriv)
	if err != nil {
		t.Fatalf("as private key: %v", err)
	}
	body, err := encryptPushWith(plaintext, uaPublic, auth, salt, priv)
	if err != nil {
		t.Fatalf("encryptPushWith: %v", err)
	}
	if got := base64.RawURLEncoding.EncodeToString(body); got != want {
		t.Errorf("RFC 8291 vector mismatch:\n got %s\nwant %s", got, want)
	}
}

// decryptPush is the receiver (user-agent) side of RFC 8291/8188, implemented
// independently in the test to prove encryptPush produces a payload a real
// browser push service / SW could decrypt. uaPriv is the subscription's private
// key (whose public half is the p256dh we encrypted to).
func decryptPush(t *testing.T, body []byte, uaPriv *ecdh.PrivateKey, authSecret []byte) []byte {
	t.Helper()
	if len(body) < 21 {
		t.Fatalf("body too short: %d", len(body))
	}
	salt := body[0:16]
	idlen := int(body[20])
	asPublic := body[21 : 21+idlen]
	ciphertext := body[21+idlen:]

	asPub, err := ecdh.P256().NewPublicKey(asPublic)
	if err != nil {
		t.Fatalf("as public: %v", err)
	}
	shared, err := uaPriv.ECDH(asPub)
	if err != nil {
		t.Fatalf("ecdh: %v", err)
	}
	uaPublic := uaPriv.PublicKey().Bytes()

	keyInfo := append([]byte("WebPush: info\x00"), uaPublic...)
	keyInfo = append(keyInfo, asPublic...)
	ikm, err := hkdf.Key(sha256.New, shared, authSecret, string(keyInfo), 32)
	if err != nil {
		t.Fatal(err)
	}
	prk, err := hkdf.Extract(sha256.New, ikm, salt)
	if err != nil {
		t.Fatal(err)
	}
	cek, _ := hkdf.Expand(sha256.New, prk, "Content-Encoding: aes128gcm\x00", 16)
	nonce, _ := hkdf.Expand(sha256.New, prk, "Content-Encoding: nonce\x00", 12)

	block, err := aes.NewCipher(cek)
	if err != nil {
		t.Fatal(err)
	}
	gcm, _ := cipher.NewGCM(block)
	rec, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		t.Fatalf("gcm open: %v", err)
	}
	// strip the RFC 8188 padding delimiter (0x02 for the last record)
	rec = bytes.TrimRight(rec, "\x00")
	if len(rec) > 0 && rec[len(rec)-1] == 0x02 {
		rec = rec[:len(rec)-1]
	}
	return rec
}

func TestPushEncryptRoundTrip(t *testing.T) {
	uaPriv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	uaPub := uaPriv.PublicKey().Bytes()
	auth := make([]byte, 16)
	_, _ = rand.Read(auth)

	plaintext := []byte(`{"type":"finished","title":"build","detail":"Turn finished"}`)
	body, err := encryptPush(plaintext, uaPub, auth)
	if err != nil {
		t.Fatalf("encryptPush: %v", err)
	}
	// header sanity: idlen must be the 65-byte uncompressed point
	if body[20] != 65 {
		t.Errorf("idlen = %d, want 65", body[20])
	}
	got := decryptPush(t, body, uaPriv, auth)
	if !bytes.Equal(got, plaintext) {
		t.Errorf("round-trip mismatch:\n got %q\nwant %q", got, plaintext)
	}
}

func TestVAPIDLoadCreateAndAuthHeader(t *testing.T) {
	dir := t.TempDir()
	cfg, err := NewStore(filepath.Join(dir, "alerts.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	p, err := NewPusher(cfg, NewPresence(), dir)
	if err != nil {
		t.Fatalf("NewPusher: %v", err)
	}
	if p.PublicKey() == "" {
		t.Error("empty VAPID public key")
	}
	// Reload must reuse the same key (stable applicationServerKey for clients).
	p2, err := NewPusher(cfg, NewPresence(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if p.PublicKey() != p2.PublicKey() {
		t.Error("VAPID key not persisted/stable across reload")
	}

	hdr, err := p.vapidAuth("https://fcm.googleapis.com/fcm/send/abc123")
	if err != nil {
		t.Fatalf("vapidAuth: %v", err)
	}
	if len(hdr) < 20 || hdr[:8] != "vapid t=" {
		t.Errorf("unexpected auth header: %q", hdr)
	}
}

func TestPushSubscribePersists(t *testing.T) {
	dir := t.TempDir()
	cfg, _ := NewStore(filepath.Join(dir, "alerts.jsonc"))
	p, _ := NewPusher(cfg, NewPresence(), dir)
	uaPriv, _ := ecdh.P256().GenerateKey(rand.Reader)
	sub := PushSub{
		DeviceID: "dev-1",
		Endpoint: "https://push.example/abc",
		P256dh:   b64url(uaPriv.PublicKey().Bytes()),
		Auth:     b64url([]byte("0123456789abcdef")),
		Scope:    "all",
	}
	if err := p.Subscribe(sub); err != nil {
		t.Fatal(err)
	}
	p2, _ := NewPusher(cfg, NewPresence(), dir)
	if p2.Count() != 1 {
		t.Errorf("subscription not persisted; count=%d", p2.Count())
	}
}
