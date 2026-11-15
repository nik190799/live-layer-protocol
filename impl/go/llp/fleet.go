package llp

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"math"
	"sync"
	"time"
)

// ---------- percentage rollouts (SPEC 12.2) ----------

// Bucket is uint32(sha256(seed + "\n" + hostId)[0..4]) mod 10000.
func Bucket(hostID, seed string) int {
	s := sha256.Sum256([]byte(seed + "\n" + hostID))
	return int(binary.BigEndian.Uint32(s[:4]) % 10000)
}

// RolloutSeed is the manifest's rollout seed, defaulting to "<app>/<channel>".
func RolloutSeed(m map[string]any) string {
	if r, ok := m["rollout"].(map[string]any); ok {
		if s, ok := r["seed"].(string); ok {
			return s
		}
	}
	app, _ := m["app"].(string)
	ch, _ := m["channel"].(string)
	return app + "/" + ch
}

// RolloutPercent is rollout.percent, defaulting to 100.
func RolloutPercent(m map[string]any) float64 {
	if r, ok := m["rollout"].(map[string]any); ok {
		if p, ok := r["percent"].(float64); ok {
			return p
		}
	}
	return 100
}

// InRollout says whether hostID is inside the manifest's share.
func InRollout(m map[string]any, hostID string) bool {
	p := RolloutPercent(m)
	if p >= 100 {
		return true
	}
	return float64(Bucket(hostID, RolloutSeed(m))) < math.Floor(p*100+0.5)
}

// ---------- keyrings (SPEC 12.4) ----------

type role struct {
	keys      []*PublicKey
	threshold int
}

func parseRole(v any, name string) (*role, error) {
	m, ok := v.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s has no keys", name)
	}
	ks, ok := m["keys"].([]any)
	if !ok || len(ks) == 0 {
		return nil, fmt.Errorf("%s has no keys", name)
	}
	r := &role{threshold: 1}
	for _, k := range ks {
		pk, err := ParseJWK(k)
		if err != nil {
			return nil, fmt.Errorf("%s: %v", name, err)
		}
		r.keys = append(r.keys, pk)
	}
	if t, has := m["threshold"]; has {
		if !IsSafeInteger(t) || t.(float64) < 1 || int(t.(float64)) > len(r.keys) {
			return nil, fmt.Errorf("%s threshold %s is invalid", name, jsonish(t))
		}
		r.threshold = int(t.(float64))
	}
	return r, nil
}

// validSigners counts distinct keys of r with a valid signature in sigs ([{kid, sig}]).
func (r *role) validSigners(doc any, sigs any) int {
	byKid := map[string]*PublicKey{}
	for _, k := range r.keys {
		byKid[k.KeyID()] = k
	}
	ok := map[string]bool{}
	list, _ := sigs.([]any)
	for _, s := range list {
		e, _ := s.(map[string]any)
		kid, _ := e["kid"].(string)
		sig, _ := e["sig"].(string)
		if k := byKid[kid]; k != nil && !ok[kid] && k.Verify(doc, sig) {
			ok[kid] = true
		}
	}
	return len(ok)
}

// TrustStore holds the keyring a fleet host trusts.
type TrustStore struct {
	Doc     map[string]any
	root    *role
	release *role
}

// NewTrustStore pins a keyring (trust on install; its signatures aren't checked).
func NewTrustStore(doc any) (*TrustStore, error) {
	m, ok := doc.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("keyring must be an object")
	}
	root, err := parseRole(m["root"], "root")
	if err != nil {
		return nil, err
	}
	rel, err := parseRole(m["release"], "release")
	if err != nil {
		return nil, err
	}
	if !IsSafeInteger(m["keyring"]) {
		return nil, fmt.Errorf("keyring number must be an integer")
	}
	return &TrustStore{Doc: m, root: root, release: rel}, nil
}

func (t *TrustStore) Version() float64          { return t.Doc["keyring"].(float64) }
func (t *TrustStore) App() string               { s, _ := t.Doc["app"].(string); return s }
func (t *TrustStore) ReleaseKeys() []*PublicKey { return t.release.keys }

// Update accepts keyring n+1 if a threshold of the current root signed it and, when it changes
// the root, a threshold of the new root too.
func (t *TrustStore) Update(doc any, sigs any) (bool, string) {
	m, ok := doc.(map[string]any)
	if !ok || m["app"] != t.App() {
		return false, "keyring for a different app"
	}
	n, isNum := m["keyring"].(float64)
	if !isNum || !(n > t.Version()) {
		return false, fmt.Sprintf("stale keyring %s ≤ %s", jsonish(m["keyring"]), NumberString(t.Version()))
	}
	if n != t.Version()+1 {
		return false, fmt.Sprintf("keyring %s skips %s; send the chain in order", NumberString(n), NumberString(t.Version()+1))
	}
	root, err := parseRole(m["root"], "root")
	if err != nil {
		return false, err.Error()
	}
	rel, err := parseRole(m["release"], "release")
	if err != nil {
		return false, err.Error()
	}
	if c := t.root.validSigners(m, sigs); c < t.root.threshold {
		return false, fmt.Sprintf("keyring %s has %d of %d current root signatures", NumberString(n), c, t.root.threshold)
	}
	if MustCanonical(m["root"]) != MustCanonical(t.Doc["root"]) {
		if c := root.validSigners(m, sigs); c < root.threshold {
			return false, fmt.Sprintf("new root has %d of %d signatures", c, root.threshold)
		}
	}
	t.Doc, t.root, t.release = m, root, rel
	return true, ""
}

// VerifyRelease checks a document signed by a release key.
func (t *TrustStore) VerifyRelease(doc any, sig string) bool {
	for _, k := range t.release.keys {
		if k.Verify(doc, sig) {
			return true
		}
	}
	return false
}

// ---------- the agent (SPEC 12.1-12.3.1) ----------

// Agent joins a host to a fleet controller: challenge-signed hello, keyrings, channels, shares,
// freshness notes and status reports. It wraps a Host without changing it.
type Agent struct {
	Host      *Host
	ID        string
	Channel   string
	Trust     *TrustStore
	DeviceKey *PrivateKey
	Send      func(map[string]any)
	// Freshness: "", "warn" or "refuse".
	Freshness string
	OnKeyring func(doc map[string]any)

	mu       sync.Mutex // one message at a time, in arrival order
	nonce    string
	target   float64
	percent  float64
	state    string
	reason   string
	fresh    *freshNote
	stale    bool
	blobMu   sync.Mutex
	pending  map[string]chan []byte
	BlobWait time.Duration
}

type freshNote struct{ epoch, version, expires float64 }

// NewAgent wires a host to its trust store (pins the app, the release keys and the epoch limit).
func NewAgent(h *Host, id, channel string, trust *TrustStore, device *PrivateKey, send func(map[string]any)) *Agent {
	a := &Agent{Host: h, ID: id, Channel: channel, Trust: trust, DeviceKey: device, Send: send, pending: map[string]chan []byte{}, BlobWait: 10 * time.Second, percent: 100}
	h.TrustedKeys = trust.ReleaseKeys()
	if h.App == "" {
		h.App = trust.App()
	}
	h.MaxEpoch = trust.Version()
	prev := h.opt.OnLog
	h.opt.OnLog = func(e LogEntry) {
		if prev != nil {
			prev(e)
		}
		if e.Kind == "rollback" {
			go func() { a.mu.Lock(); a.report("reverted", e.Msg, nil); a.mu.Unlock() }() // the host lock is held while it logs
		}
	}
	return a
}

// Connected resets the challenge for a new connection.
func (a *Agent) Connected() { a.mu.Lock(); a.nonce = ""; a.mu.Unlock() }

func (a *Agent) channelValue() any {
	if a.Channel == "" {
		return nil
	}
	return a.Channel
}

func (a *Agent) hello() {
	if a.nonce == "" {
		return
	}
	have := []any{}
	for _, hs := range a.Host.HaveBlobs() {
		have = append(have, hs)
	}
	body := map[string]any{"t": "hello", "llp": float64(LLPVersion), "app": a.Trust.App(), "host": a.ID, "channel": a.channelValue(), "version": a.Host.Version, "keyring": a.Trust.Version(), "have": have}
	signed := map[string]any{"nonce": a.nonce}
	for k, v := range body {
		signed[k] = v
	}
	sig, err := a.DeviceKey.Sign(signed)
	if err != nil {
		return
	}
	body["auth"] = map[string]any{"key": a.DeviceKey.Pub.JWK, "sig": sig}
	a.Send(body)
}

func (a *Agent) report(state, reason string, extra map[string]any) map[string]any {
	a.state, a.reason = state, reason
	running := map[string]any{}
	for k, v := range a.Host.Running() {
		running[k] = v
	}
	msg := map[string]any{"t": "status", "host": a.ID, "channel": a.channelValue(), "version": a.Host.Version, "keyring": a.Trust.Version(), "target": a.target, "percent": a.percent, "state": state, "reason": reason, "running": running}
	for k, v := range extra {
		msg[k] = v
	}
	a.Send(msg)
	return msg
}

func (a *Agent) want(hash string) ([]byte, error) {
	ch := make(chan []byte, 1)
	a.blobMu.Lock()
	a.pending[hash] = ch
	a.blobMu.Unlock()
	a.Send(map[string]any{"t": "want", "hashes": []any{hash}})
	select {
	case b := <-ch:
		return b, nil
	case <-time.After(a.BlobWait):
		a.blobMu.Lock()
		delete(a.pending, hash)
		a.blobMu.Unlock()
		return nil, fmt.Errorf("blob %s never arrived", hash[:8])
	}
}

// Receive handles one message from the controller. Blobs and challenges are handled at once;
// everything else runs in arrival order. Returns the status it reported, if any.
func (a *Agent) Receive(msg map[string]any) map[string]any {
	switch msg["t"] {
	case "blob":
		hs, _ := msg["hash"].(string)
		data, _ := msg["data"].(string)
		a.blobMu.Lock()
		ch := a.pending[hs]
		delete(a.pending, hs)
		a.blobMu.Unlock()
		if ch != nil {
			b, err := B64Decode(data)
			if err == nil {
				ch <- b
			}
		}
		return nil
	case "challenge":
		if n, ok := msg["nonce"].(string); ok {
			a.mu.Lock()
			a.nonce = n
			a.hello()
			a.mu.Unlock()
		}
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.handle(msg)
}

func (a *Agent) done(state, reason string, extra map[string]any) map[string]any {
	return a.report(state, reason, extra)
}

func (a *Agent) handle(msg map[string]any) map[string]any {
	switch msg["t"] {
	case "keyring":
		ok, why := a.Trust.Update(msg["doc"], msg["sigs"])
		if !ok {
			return a.report("keyring-rejected", why, nil)
		}
		a.Host.mu.Lock()
		a.Host.TrustedKeys = a.Trust.ReleaseKeys()
		a.Host.MaxEpoch = a.Trust.Version()
		a.Host.mu.Unlock()
		if a.OnKeyring != nil {
			a.OnKeyring(a.Trust.Doc)
		}
		missed := a.state == "rejected" && (contains(a.reason, "signature") || contains(a.reason, "epoch"))
		r := a.report("keyring", "keyring "+NumberString(a.Trust.Version()), nil)
		if missed {
			a.hello()
		}
		return r
	case "fresh":
		a.onFresh(msg)
		return nil
	case "manifest":
	default:
		return nil
	}
	m, _ := msg["manifest"].(map[string]any)
	sig, _ := msg["sig"].(string)
	if m == nil || !a.Trust.VerifyRelease(m, sig) {
		return a.reject(m, CodeUntrusted, "signature not trusted")
	}
	if m["app"] != a.Trust.App() {
		return a.reject(m, CodeWrongApp, "different app")
	}
	if m["channel"] != a.channelValue() {
		return a.reject(m, "channel", fmt.Sprintf("manifest is for channel %s, host is on %s", orNone(m["channel"]), orNone(a.channelValue())))
	}
	cmp := a.Host.CompareVersion(m)
	if cmp < 0 {
		return nil // a late duplicate or a replay: ignored without a report
	}
	if cmp > 0 {
		e, v := num(m["epoch"], 0), num(m["version"], 0)
		if f := a.fresh; f != nil && (e < f.epoch || (e == f.epoch && v < f.version)) {
			return a.reject(m, "freshness", fmt.Sprintf("v%s is older than v%s, the latest release the controller vouched for", NumberString(v), NumberString(f.version)))
		}
		if a.Freshness == "refuse" {
			if why := a.staleReason(nowMs()); why != "" && (a.fresh == nil || a.fresh.expires <= nowMs()) {
				return a.reject(m, "freshness", "no valid freshness note ("+why+"); refusing to install")
			}
		}
	}
	a.target = num(m["version"], 0)
	a.percent = RolloutPercent(m)
	if cmp == 0 {
		st := "live"
		if a.state == "reverted" {
			st = "reverted"
		}
		return a.done(st, "already on this version", nil)
	}
	if !InRollout(m, a.ID) {
		return a.done("skipped", fmt.Sprintf("not in the %s%% share", NumberString(RolloutPercent(m))), nil)
	}
	r := a.Host.Apply(m, sig, a.want)
	if r.OK {
		return a.done("live", fmt.Sprintf("%v ms", r.Ms), map[string]any{"ms": r.Ms})
	}
	return a.done("rejected", r.Reason, map[string]any{"code": r.Code})
}

func (a *Agent) reject(m map[string]any, code, reason string) map[string]any {
	extra := map[string]any{"code": code}
	if m != nil {
		extra["target"] = m["version"]
	}
	return a.done("rejected", reason, extra)
}

func (a *Agent) onFresh(msg map[string]any) {
	doc, _ := msg["doc"].(map[string]any)
	sig, _ := msg["sig"].(string)
	if doc == nil || doc["kind"] != "llp-freshness" || doc["app"] != a.Trust.App() || doc["channel"] != a.channelValue() {
		return
	}
	if !IsSafeInteger(doc["version"]) || !IsSafeInteger(doc["epoch"]) {
		return
	}
	exp, ok := doc["expires"].(float64)
	if !ok || !a.Trust.VerifyRelease(doc, sig) || exp <= nowMs() || doc["epoch"].(float64) > a.Trust.Version() {
		return
	}
	n := &freshNote{epoch: doc["epoch"].(float64), version: doc["version"].(float64), expires: exp}
	if f := a.fresh; f != nil && (n.epoch < f.epoch || (n.epoch == f.epoch && (n.version < f.version || (n.version == f.version && n.expires <= f.expires)))) {
		return
	}
	a.fresh, a.stale = n, false
	if a.state == "rejected" && contains(a.reason, "freshness note") {
		a.hello()
	}
}

func (a *Agent) staleReason(now float64) string {
	if a.fresh == nil {
		return "no freshness note yet"
	}
	if a.fresh.expires <= now {
		return fmt.Sprintf("freshness note expired %d s ago", int((now-a.fresh.expires)/1000))
	}
	if a.Host.CompareVersion(map[string]any{"epoch": a.fresh.epoch, "version": a.fresh.version}) < 0 && a.state != "skipped" {
		return fmt.Sprintf("running v%s, but v%s is out", NumberString(a.Host.Version), NumberString(a.fresh.version))
	}
	return ""
}

// CheckFreshness reports "freshness-expired" once when the held note runs out. Call on a timer.
func (a *Agent) CheckFreshness() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.Freshness == "" {
		return ""
	}
	now := nowMs()
	why := a.staleReason(now)
	if why != "" && a.fresh != nil && a.fresh.expires <= now && !a.stale {
		a.stale = true
		a.report("freshness-expired", why, nil)
	}
	return why
}

func nowMs() float64 { return float64(time.Now().UnixMilli()) }
func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
func orNone(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return "(none)"
}
