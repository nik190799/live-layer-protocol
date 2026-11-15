package llp

import (
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"math/big"
	"strings"
)

// SHA256Hex is the content address of a layer: lowercase hex SHA-256 (SPEC section 3.2).
func SHA256Hex(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

// B64Decode reads standard base64. Padding is optional, matching the reference transport's
// atob(); producers always pad.
func B64Decode(s string) ([]byte, error) {
	s = strings.TrimRight(s, "=")
	return base64.RawStdEncoding.DecodeString(s)
}

// B64Encode writes standard, padded base64.
func B64Encode(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func b64url(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
}

// PublicKey is a P-256 ECDSA public key given as a JWK (SPEC section 4).
type PublicKey struct {
	JWK map[string]any
	key *ecdsa.PublicKey
}

// ParseJWK accepts {kty:"EC", crv:"P-256", x, y} (other members are ignored) and checks the point
// is on the curve.
func ParseJWK(v any) (*PublicKey, error) {
	m, ok := v.(map[string]any)
	if !ok {
		return nil, errors.New("jwk: not an object")
	}
	if m["kty"] != "EC" || m["crv"] != "P-256" {
		return nil, errors.New("jwk: need kty EC, crv P-256")
	}
	xs, _ := m["x"].(string)
	ys, _ := m["y"].(string)
	x, err1 := b64url(xs)
	y, err2 := b64url(ys)
	if err1 != nil || err2 != nil || len(x) != 32 || len(y) != 32 {
		return nil, errors.New("jwk: x and y must be 32-byte base64url")
	}
	raw := append([]byte{4}, append(x, y...)...)
	if _, err := ecdh.P256().NewPublicKey(raw); err != nil { // validates the point
		return nil, errors.New("jwk: point is not on P-256")
	}
	return &PublicKey{JWK: m, key: &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}}, nil
}

// PublicMembers is the {crv,kty,x,y} subset that key ids are computed over (SPEC 12.4).
func (k *PublicKey) PublicMembers() map[string]any {
	return map[string]any{"crv": k.JWK["crv"], "kty": k.JWK["kty"], "x": k.JWK["x"], "y": k.JWK["y"]}
}

// KeyID is the first 16 hex characters of SHA-256 over the canonical {crv,kty,x,y} (SPEC 12.4).
func (k *PublicKey) KeyID() string { return SHA256Hex([]byte(MustCanonical(k.PublicMembers())))[:16] }

// Verify checks sig (base64 of the 64-byte IEEE P1363 r||s form, which is what WebCrypto emits)
// over the canonical JSON of doc. A DER-encoded signature is not accepted.
func (k *PublicKey) Verify(doc any, sig string) bool {
	msg, err := Canonical(doc)
	if err != nil {
		return false
	}
	raw, err := B64Decode(sig)
	if err != nil || len(raw) != 64 {
		return false
	}
	h := sha256.Sum256([]byte(msg))
	r, s := new(big.Int).SetBytes(raw[:32]), new(big.Int).SetBytes(raw[32:])
	return ecdsa.Verify(k.key, h[:], r, s)
}

// PrivateKey signs documents (device keys for fleet hellos, and test publishers).
type PrivateKey struct {
	key *ecdsa.PrivateKey
	Pub *PublicKey
}

func pad32(b []byte) []byte { out := make([]byte, 32); copy(out[32-len(b):], b); return out }

// GenerateKey makes a new P-256 key pair.
func GenerateKey() (*PrivateKey, error) {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	return wrapPrivate(k), nil
}

func wrapPrivate(k *ecdsa.PrivateKey) *PrivateKey {
	jwk := map[string]any{"kty": "EC", "crv": "P-256",
		"x": base64.RawURLEncoding.EncodeToString(pad32(k.X.Bytes())),
		"y": base64.RawURLEncoding.EncodeToString(pad32(k.Y.Bytes()))}
	pub, _ := ParseJWK(jwk)
	return &PrivateKey{key: k, Pub: pub}
}

// PrivateJWK exports the key with its "d" member, for saving.
func (k *PrivateKey) PrivateJWK() map[string]any {
	m := map[string]any{}
	for kk, v := range k.Pub.JWK {
		m[kk] = v
	}
	m["d"] = base64.RawURLEncoding.EncodeToString(pad32(k.key.D.Bytes()))
	return m
}

// ParsePrivateJWK reads a key saved with PrivateJWK (or exported by WebCrypto).
func ParsePrivateJWK(v any) (*PrivateKey, error) {
	pub, err := ParseJWK(v)
	if err != nil {
		return nil, err
	}
	ds, _ := v.(map[string]any)["d"].(string)
	d, err := b64url(ds)
	if err != nil || len(d) != 32 {
		return nil, errors.New("jwk: bad d")
	}
	k := &ecdsa.PrivateKey{PublicKey: *pub.key, D: new(big.Int).SetBytes(d)}
	return &PrivateKey{key: k, Pub: pub}, nil
}

// Sign returns base64 of r||s over the canonical JSON of doc.
func (k *PrivateKey) Sign(doc any) (string, error) {
	msg, err := Canonical(doc)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256([]byte(msg))
	r, s, err := ecdsa.Sign(rand.Reader, k.key, h[:])
	if err != nil {
		return "", err
	}
	return B64Encode(append(pad32(r.Bytes()), pad32(s.Bytes())...)), nil
}
