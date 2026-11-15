package llp

import (
	"context"
	"fmt"
	"math"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Rejection codes (SPEC section 5, nack.code). The reason text is for people; the code is for
// programs and for the conformance suite.
const (
	CodeMalformed   = "malformed"
	CodeUntrusted   = "untrusted"
	CodeWrongApp    = "wrong_app"
	CodeProtocol    = "protocol"
	CodeBadVersion  = "bad_version"
	CodeStale       = "stale"
	CodeBlob        = "blob"
	CodeLayerFailed = "layer_failed"
)

// LLPVersion is the protocol version this host implements (SPEC section 4).
const LLPVersion = 1

// MaxVersionAheadMs: a manifest version may be at most one year of milliseconds ahead of
// max(running version, clock) (SPEC section 6 step 2).
const MaxVersionAheadMs = 365 * 24 * 3600 * 1000

var manifestFields = map[string]bool{"llp": true, "app": true, "version": true, "epoch": true, "layers": true, "order": true, "hosts": true, "keys": true, "caps": true, "private": true, "channel": true, "rollout": true, "overlap": true}
var hashRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Limits are the sandbox limits of SPEC section 6.1 and the quotas of section 11.
type Limits struct {
	CallMs, FirstCallMs, LoadMs, MemoryMb, UINodes, BlobMb, MaxKeys, MaxValueKb int
}

// DefaultLimits are the client defaults.
var DefaultLimits = Limits{CallMs: 100, FirstCallMs: 1000, LoadMs: 2000, MemoryMb: 32, UINodes: 10000, BlobMb: 16, MaxKeys: 2_000_000, MaxValueKb: 256}

// Capability answers a capability request. ok=false means "no result" (no event is delivered).
type Capability func(arg string) (result string, ok bool, err error)

// LogEntry is one host log line.
type LogEntry struct {
	Kind, Msg, Slot string
}

// SlotView is one slot's rendered tree, or its error.
type SlotView struct {
	Slot  string
	Tree  *Node
	Error string
}

// Result of applying a manifest.
type Result struct {
	OK      bool
	Code    string
	Reason  string
	Version float64
	Ms      float64
	Swapped []string
}

type slot struct {
	hash string
	in   *instance
	prev []string
}

// Options configure a Host.
type Options struct {
	App           string
	TrustedKeys   []*PublicKey
	AllowUnsigned bool
	Capabilities  map[string]Capability
	OnRender      func([]SlotView)
	OnLog         func(LogEntry)
	Limits        *Limits
	MaxPrev       int
	Now           func() float64 // ms since the epoch; defaults to the wall clock
	MaxAheadMs    float64
}

// Host is a client Live Host (SPEC sections 3-9). It owns state, verifies and swaps layers, and
// reverts a slot whose code traps.
type Host struct {
	mu          sync.Mutex
	opt         Options
	limits      Limits
	eng         *Engine
	KV          *Store
	Blobs       map[string][]byte
	slots       map[string]*slot
	order       []string
	App         string
	TrustedKeys []*PublicKey
	MaxEpoch    float64
	Version     float64
	Epoch       float64
	Manifest    map[string]any
	keyRules    map[string]*keyRule
	capRules    map[string]map[string]bool
	History     []LogEntry
	LastRender  []SlotView
}

// NewHost creates a host. Without trusted keys (and without AllowUnsigned) it refuses everything.
func NewHost(opt Options) (*Host, error) {
	lim := DefaultLimits
	if opt.Limits != nil {
		lim = *opt.Limits
	}
	if opt.MaxPrev == 0 {
		opt.MaxPrev = 5
	}
	if opt.Now == nil {
		opt.Now = func() float64 { return float64(time.Now().UnixMilli()) }
	}
	if opt.MaxAheadMs == 0 {
		opt.MaxAheadMs = MaxVersionAheadMs
	}
	eng, err := newEngine(context.Background(), lim.MemoryMb)
	if err != nil {
		return nil, err
	}
	h := &Host{opt: opt, limits: lim, eng: eng, KV: NewStore(), Blobs: map[string][]byte{}, slots: map[string]*slot{}, App: opt.App, TrustedKeys: opt.TrustedKeys}
	if opt.AllowUnsigned {
		h.log("security", "allowUnsigned is on: manifests are NOT signature-checked. Use this only for development and shadow checks.", "")
	}
	return h, nil
}

// Close releases the engine.
func (h *Host) Close() { h.eng.Close() }

func (h *Host) log(kind, msg, slot string) {
	e := LogEntry{Kind: kind, Msg: msg, Slot: slot}
	h.History = append(h.History, e)
	if len(h.History) > 5000 {
		h.History = h.History[1000:]
	}
	if h.opt.OnLog != nil {
		h.opt.OnLog(e)
	}
}

// Running returns the hash each slot actually runs (differs from the manifest after a revert).
func (h *Host) Running() map[string]string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := map[string]string{}
	for k, s := range h.slots {
		out[k] = s.hash
	}
	return out
}

// HaveBlobs lists the content hashes held (for hello.have).
func (h *Host) HaveBlobs() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := []string{}
	for k := range h.Blobs {
		out = append(out, k)
	}
	return out
}

func num(v any, def float64) float64 {
	if f, ok := v.(float64); ok {
		return f
	}
	return def
}

// CompareVersion orders m against the running release by (epoch, version): -1, 0 or 1.
func (h *Host) CompareVersion(m map[string]any) int {
	e, v := num(m["epoch"], 0), num(m["version"], math.NaN())
	if e != h.Epoch {
		if e > h.Epoch {
			return 1
		}
		return -1
	}
	if v == h.Version {
		return 0
	}
	if v > h.Version {
		return 1
	}
	return -1
}

func (h *Host) versionProblem(m map[string]any) (string, string) {
	if !IsSafeInteger(m["version"]) || m["version"].(float64) < 1 {
		return CodeBadVersion, fmt.Sprintf("version must be a positive safe integer, got %s", jsonish(m["version"]))
	}
	if ev, has := m["epoch"]; has && (!IsSafeInteger(ev) || ev.(float64) < 0) {
		return CodeBadVersion, fmt.Sprintf("epoch must be a non-negative safe integer, got %s", jsonish(ev))
	}
	v, e := m["version"].(float64), num(m["epoch"], 0)
	if e > h.MaxEpoch {
		return CodeBadVersion, fmt.Sprintf("epoch %s is beyond the trusted keyring (%s)", NumberString(e), NumberString(h.MaxEpoch))
	}
	if h.CompareVersion(m) <= 0 {
		if e < h.Epoch {
			return CodeStale, fmt.Sprintf("stale epoch %s < %s", NumberString(e), NumberString(h.Epoch))
		}
		return CodeStale, fmt.Sprintf("stale version %s ≤ %s", NumberString(v), NumberString(h.Version))
	}
	base := h.opt.Now()
	if e == h.Epoch && h.Version > base {
		base = h.Version
	}
	if v > base+h.opt.MaxAheadMs {
		return CodeBadVersion, fmt.Sprintf("version %s is too far ahead (limit %s); it would block every later release", NumberString(v), NumberString(base+h.opt.MaxAheadMs))
	}
	return "", ""
}

func jsonish(v any) string {
	if v == nil {
		return "undefined"
	}
	s, err := Canonical(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return s
}

func protocolProblem(m map[string]any) string {
	lv, has := m["llp"]
	if !has {
		return ""
	}
	if !IsSafeInteger(lv) || lv.(float64) < 1 {
		return fmt.Sprintf("llp must be a positive integer, got %s", jsonish(lv))
	}
	if lv.(float64) > LLPVersion {
		return fmt.Sprintf("manifest needs LLP %s; this host implements up to %d", NumberString(lv.(float64)), LLPVersion)
	}
	var unknown []string
	for _, k := range SortedKeys(m) {
		if !manifestFields[k] && !strings.HasPrefix(k, "x-") {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		return fmt.Sprintf("unknown field(s) %s in an LLP 1 manifest (prefix optional fields with x-)", strings.Join(unknown, ", "))
	}
	if _, ok := m["keys"]; !ok {
		return "an LLP 1 manifest must declare keys for every slot"
	}
	if _, ok := m["caps"]; !ok {
		return "an LLP 1 manifest must declare caps (use {} for none)"
	}
	return ""
}

func placement(m map[string]any, slot string) any {
	if hosts, ok := m["hosts"].(map[string]any); ok {
		if p, ok := hosts[slot]; ok {
			return p
		}
	}
	return "client"
}

func stringList(v any, max, maxLen int) ([]string, bool) {
	a, ok := v.([]any)
	if !ok || len(a) > max {
		return nil, false
	}
	out := []string{}
	for _, x := range a {
		s, ok := x.(string)
		if !ok || s == "" || UTF16Len(s) > maxLen {
			return nil, false
		}
		out = append(out, s)
	}
	return out, true
}

const hostKeys = "__schema."

// parseRules validates the declared fields of SPEC 6.2, 9, 10.2 and 10.3.
func parseRules(m map[string]any, layers map[string]any) (map[string]*keyRule, map[string]map[string]bool, error) {
	slots := SortedKeys(layers)
	for _, s := range slots {
		if hs, ok := layers[s].(string); !ok || !hashRe.MatchString(hs) {
			return nil, nil, fmt.Errorf("layers.%s must be a lowercase hex SHA-256", s)
		}
	}
	if o, has := m["order"]; has {
		a, ok := o.([]any)
		if !ok {
			return nil, nil, fmt.Errorf("order must be a list of slot names")
		}
		for _, x := range a {
			s, ok := x.(string)
			if _, in := layers[s]; !ok || !in {
				return nil, nil, fmt.Errorf("order names %s, which is not a slot in layers", jsonish(x))
			}
		}
	}
	var keys map[string]*keyRule
	if decl, has := m["keys"]; has {
		d, ok := decl.(map[string]any)
		if !ok {
			return nil, nil, fmt.Errorf("keys must be an object of { slot: { own, read } }")
		}
		keys = map[string]*keyRule{}
		type owner struct{ p, slot string }
		var owners []owner
		for _, s := range slots {
			e, ok := d[s].(map[string]any)
			if !ok {
				return nil, nil, fmt.Errorf("keys: slot %s declares no keys (every slot needs an entry once a manifest declares keys)", s)
			}
			list := func(name string) ([]string, error) {
				v, has := e[name]
				if !has {
					return []string{}, nil
				}
				l, ok := stringList(v, 64, 256)
				if !ok {
					return nil, fmt.Errorf("keys.%s.%s must be a list of up to 64 non-empty prefixes", s, name)
				}
				for _, p := range l {
					if strings.HasPrefix(p, hostKeys) || strings.HasPrefix(hostKeys, p) {
						return nil, fmt.Errorf("keys.%s.%s: %s* keys belong to the host", s, name, hostKeys)
					}
				}
				return l, nil
			}
			own, err := list("own")
			if err != nil {
				return nil, nil, err
			}
			read, err := list("read")
			if err != nil {
				return nil, nil, err
			}
			for _, p := range own {
				for _, o := range owners {
					if strings.HasPrefix(p, o.p) || strings.HasPrefix(o.p, p) {
						return nil, nil, fmt.Errorf(`keys: "%s" (%s) overlaps "%s" (%s); a key has one owner`, p, s, o.p, o.slot)
					}
				}
			}
			for _, p := range own {
				owners = append(owners, owner{p, s})
			}
			keys[s] = &keyRule{own: own, read: read}
		}
	}
	var caps map[string]map[string]bool
	if decl, has := m["caps"]; has {
		d, ok := decl.(map[string]any)
		if !ok {
			return nil, nil, fmt.Errorf("caps must be an object of { slot: [names] }")
		}
		caps = map[string]map[string]bool{}
		for _, s := range SortedKeys(d) {
			if _, in := layers[s]; !in {
				return nil, nil, fmt.Errorf("caps: no slot named %s", s)
			}
			l, ok := stringList(d[s], 64, 64)
			if !ok {
				return nil, nil, fmt.Errorf("caps.%s must be a list of up to 64 capability names", s)
			}
			set := map[string]bool{}
			for _, n := range l {
				set[n] = true
			}
			caps[s] = set
		}
		for _, s := range slots {
			if caps[s] == nil {
				caps[s] = map[string]bool{}
			}
		}
	}
	if p, has := m["private"]; has {
		l, ok := stringList(p, 64, 256)
		valid := ok
		for _, x := range l {
			if !strings.HasPrefix(x, "shared/") || len(x) <= 7 {
				valid = false
			}
		}
		if !valid {
			return nil, nil, fmt.Errorf("private must be a list of up to 64 shared/ prefixes")
		}
	}
	if ov, has := m["overlap"]; has && (!IsSafeInteger(ov) || ov.(float64) < 0) {
		return nil, nil, fmt.Errorf("overlap must be a non-negative number of milliseconds")
	}
	return keys, caps, nil
}

func (h *Host) reject(m map[string]any, code, reason string) Result {
	v := num(m["version"], math.NaN())
	h.log("reject", fmt.Sprintf("v%s rejected: %s", NumberString(v), reason), "")
	return Result{OK: false, Code: code, Reason: reason, Version: v}
}

// FetchBlob returns the bytes for a hash (from the publisher's "blob" messages, a cache, a CDN).
type FetchBlob func(hash string) ([]byte, error)

// Apply verifies and, if everything checks out, commits a manifest (SPEC section 6).
func (h *Host) Apply(manifest any, sig string, fetch FetchBlob) Result {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.applyLocked(manifest, sig, fetch)
}

func (h *Host) applyLocked(manifest any, sig string, fetch FetchBlob) Result {
	t0 := time.Now()
	m, ok := manifest.(map[string]any)
	if !ok {
		return h.reject(map[string]any{}, CodeMalformed, "malformed manifest")
	}
	layers, ok := m["layers"].(map[string]any)
	if !ok {
		return h.reject(m, CodeMalformed, "malformed manifest")
	}
	// 1. signature, pinned app
	if !h.opt.AllowUnsigned {
		if len(h.TrustedKeys) == 0 {
			return h.reject(m, CodeUntrusted, "no trusted keys configured; refusing every manifest (fail closed)")
		}
		good := false
		for _, k := range h.TrustedKeys {
			if k.Verify(m, sig) {
				good = true
				break
			}
		}
		if !good {
			return h.reject(m, CodeUntrusted, "signature not trusted")
		}
		if h.App == "" {
			return h.reject(m, CodeUntrusted, "host has no app pinned; refusing (pass the app name when creating the host)")
		}
	}
	if h.App != "" && m["app"] != h.App {
		return h.reject(m, CodeWrongApp, "different app")
	}
	if p := protocolProblem(m); p != "" {
		return h.reject(m, CodeProtocol, p)
	}
	// 2. version rules
	if code, p := h.versionProblem(m); p != "" {
		return h.reject(m, code, p)
	}
	slots := SortedKeys(layers)
	for _, s := range slots {
		switch placement(m, s) {
		case "client", "server", "any":
		default:
			return h.reject(m, CodeMalformed, fmt.Sprintf("%s: unknown host %s", s, jsonish(placement(m, s))))
		}
	}
	rules, caps, err := parseRules(m, layers)
	if err != nil {
		return h.reject(m, CodeMalformed, err.Error())
	}
	// Only the slots placed on this host are fetched and run. Slots are staged in canonical
	// (sorted) order, which the signature covers; wire key order is not signed.
	var mine []string
	for _, s := range slots {
		if p := placement(m, s); p == "client" || p == "any" {
			mine = append(mine, s)
		}
	}
	// 3. fetch what we don't have; check sizes and hashes
	for _, s := range mine {
		hs := layers[s].(string)
		if _, have := h.Blobs[hs]; have {
			continue
		}
		b, err := fetch(hs)
		if err != nil || b == nil {
			return h.reject(m, CodeBlob, fmt.Sprintf("blob %s is missing", hs[:8]))
		}
		if len(b) > h.limits.BlobMb<<20 {
			return h.reject(m, CodeBlob, fmt.Sprintf("blob %s is %d MB, over the %d MB limit", hs[:8], (len(b)+(1<<20)-1)>>20, h.limits.BlobMb))
		}
		if SHA256Hex(b) != hs {
			return h.reject(m, CodeBlob, fmt.Sprintf("blob %s failed integrity check", hs[:8]))
		}
		h.Blobs[hs] = b
	}
	// 4-5. stage every changed slot in a copy-on-write shadow
	shadow := NewShadow(h.KV)
	type staged struct {
		slot, hash string
		in         *instance
	}
	var done []staged
	fail := func(e error) Result {
		for _, s := range done {
			s.in.kill("staging failed")
		}
		return h.reject(m, CodeLayerFailed, e.Error())
	}
	for _, s := range mine {
		hs := layers[s].(string)
		if cur := h.slots[s]; cur != nil && cur.hash == hs {
			continue
		}
		in, err := h.load(s, hs, rules[s])
		if err != nil {
			return fail(err)
		}
		done = append(done, staged{s, hs, in})
		want := float64(in.schema)
		have := want
		if v, ok := shadow.Get(hostKeys + s); ok {
			have = num(v, want)
		}
		if want != have {
			if !in.hasMigrate {
				return fail(layerErr("%s: schema %s→%s but no llp_migrate", s, NumberString(have), NumberString(want)))
			}
			if _, err := h.call(s, in, "llp_migrate", shadow, nil, []uint64{uint64(uint32(int32(have)))}, true); err != nil {
				return fail(err)
			}
		}
		shadow.Set(hostKeys+s, want)
		if in.hasView {
			if _, err := h.call(s, in, "llp_view", shadow, nil, nil, true); err != nil {
				return fail(err)
			}
		}
	}
	// 7. atomic commit
	shadow.Commit()
	var swapped []string
	for _, st := range done {
		cur := h.slots[st.slot]
		prev := []string{}
		if cur != nil {
			cur.in.kill("replaced")
			prev = append([]string{cur.hash}, cur.prev...)
			if len(prev) > h.opt.MaxPrev {
				prev = prev[:h.opt.MaxPrev]
			}
		}
		h.slots[st.slot] = &slot{hash: st.hash, in: st.in, prev: prev}
		swapped = append(swapped, st.slot)
	}
	h.keyRules, h.capRules = rules, caps
	for s, sl := range h.slots {
		sl.in.rule = h.keyRules[s]
	}
	keep := map[string]bool{}
	for _, s := range mine {
		keep[s] = true
	}
	for s, sl := range h.slots {
		if !keep[s] {
			sl.in.kill("removed")
			delete(h.slots, s)
		}
	}
	h.order = nil
	if o, ok := m["order"].([]any); ok {
		for _, x := range o {
			if keep[x.(string)] {
				h.order = append(h.order, x.(string))
			}
		}
	} else {
		h.order = mine
	}
	h.App, _ = m["app"].(string)
	h.Version = m["version"].(float64)
	h.Epoch = num(m["epoch"], 0)
	h.Manifest = m
	ms := math.Round(float64(time.Since(t0).Microseconds())/100) / 10
	h.log("swap", fmt.Sprintf("v%s live — %d layer(s) swapped in %v ms", NumberString(h.Version), len(swapped), ms), "")
	h.renderLocked()
	return Result{OK: true, Version: h.Version, Ms: ms, Swapped: swapped}
}

func (h *Host) load(slotName, hash string, rule *keyRule) (*instance, error) {
	in, logs, err := h.eng.load(context.Background(), hash, h.Blobs[hash], false, h.limits.LoadMs, h.opt.Now)
	h.flushLogs(slotName, logs)
	if err != nil {
		return nil, err
	}
	in.rule = rule
	return in, nil
}

func (h *Host) flushLogs(slot string, logs []string) {
	for _, l := range logs {
		h.log("layer", l, slot)
	}
}

// call runs one entry point; with apply the writes land in kv only if the call finishes cleanly.
func (h *Host) call(slotName string, in *instance, fn string, kv KV, ev *Event, args []uint64, apply bool) (*callResult, error) {
	ms := h.limits.CallMs
	if in.calls == 0 && h.limits.FirstCallMs > ms {
		ms = h.limits.FirstCallMs
	}
	in.calls++
	r, err := h.eng.call(context.Background(), in, fn, kv, ev, args, ms, h.limits.UINodes, h.opt.Now)
	if r != nil {
		h.flushLogs(slotName, r.logs)
	}
	if err == nil {
		r.writes = h.filterWrites(slotName, r.writes)
		err = h.checkWrites(slotName, in.rule, r.writes)
	}
	if err == nil {
		err = h.checkQuota(slotName, kv, r.writes)
	}
	if err != nil {
		return nil, layerErr("%s: %s", fn, err.Error())
	}
	if apply {
		for _, w := range r.writes {
			kv.Set(w.k, w.v)
		}
	}
	return r, nil
}

// On a client, shared/ is a read cache owned by the server host (SPEC 10.2): writes are dropped.
func (h *Host) filterWrites(slot string, ws []kvPair) []kvPair {
	var kept []kvPair
	for _, w := range ws {
		if !strings.HasPrefix(w.k, "shared/") {
			kept = append(kept, w)
		}
	}
	if len(kept) != len(ws) {
		h.log("error", slot+": wrote shared/ keys on a client; dropped (shared/ is owned by the server host)", slot)
	}
	return kept
}

func (h *Host) checkWrites(slot string, rule *keyRule, ws []kvPair) error {
	for _, w := range ws {
		if strings.HasPrefix(w.k, hostKeys) {
			return layerErr(`%s wrote "%s": %s* keys belong to the host`, slot, w.k, hostKeys)
		}
		if rule != nil && !under(rule.own, w.k) {
			return layerErr(`%s wrote "%s", outside the keys it owns`, slot, w.k)
		}
	}
	return nil
}

func (h *Host) checkQuota(slot string, kv KV, ws []kvPair) error {
	added := 0
	for _, w := range ws {
		if s, ok := w.v.(string); ok && UTF16Len(s) > h.limits.MaxValueKb*1024 {
			return layerErr(`%s wrote %d KB to "%s"; the limit is %d KB per value`, slot, (UTF16Len(s)+1023)/1024, w.k, h.limits.MaxValueKb)
		}
		if UTF16Len(w.k) > 1024 {
			return layerErr("%s wrote a key longer than 1024 characters", slot)
		}
		if _, has := kv.Get(w.k); !has {
			added++
		}
	}
	if added > 0 && kv.Len()+added > h.limits.MaxKeys {
		return layerErr("%s would grow state to %d keys; the limit is %d", slot, kv.Len()+added, h.limits.MaxKeys)
	}
	return nil
}

// Render runs every slot's llp_view against current state.
func (h *Host) Render() []SlotView {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.renderLocked()
}

func (h *Host) renderLocked() []SlotView {
	type view struct {
		v      SlotView
		writes []kvPair
	}
	var views []view
	for _, s := range h.order {
		for {
			sl := h.slots[s]
			if sl == nil {
				break
			}
			r, err := h.call(s, sl.in, "llp_view", h.KV, nil, nil, false)
			if err == nil {
				views = append(views, view{SlotView{Slot: s, Tree: r.tree}, r.writes})
				break
			}
			if !h.revert(s, err) {
				views = append(views, view{v: SlotView{Slot: s, Error: err.Error()}})
				break
			}
		}
	}
	out := []SlotView{}
	for _, v := range views { // layers render against the same state; writes merge in slot order
		for _, w := range v.writes {
			h.KV.Set(w.k, w.v)
		}
		out = append(out, v.v)
	}
	h.LastRender = out
	if h.opt.OnRender != nil {
		h.opt.OnRender(out)
	}
	return out
}

// Dispatch delivers an event to a slot as a transaction; capability requests it makes are run
// afterwards and their results come back as "cap:<name>" events.
func (h *Host) Dispatch(slotName, id, value string) {
	h.mu.Lock()
	var effects []Effect
	if sl := h.slots[slotName]; sl != nil {
		r, err := h.call(slotName, sl.in, "llp_event", h.KV, &Event{ID: id, Value: value}, nil, true)
		if err != nil {
			h.revert(slotName, err)
		} else {
			effects = r.effects
		}
		h.renderLocked()
	}
	h.mu.Unlock()
	for _, fx := range effects {
		h.runCapability(slotName, fx)
	}
}

func (h *Host) capAllowed(slot, name string) bool {
	if h.capRules == nil {
		return true
	}
	return h.capRules[slot][name]
}

func (h *Host) runCapability(slot string, fx Effect) {
	h.mu.Lock()
	allowed := h.capAllowed(slot, fx.Name)
	h.mu.Unlock()
	if !allowed {
		h.log("cap", fmt.Sprintf(`capability "%s" is not declared for %s in this release; refused`, fx.Name, slot), slot)
		h.Dispatch(slot, "cap:"+fx.Name, "error: not granted")
		return
	}
	impl := h.opt.Capabilities[fx.Name]
	if impl == nil {
		h.log("cap", fmt.Sprintf(`capability "%s" not granted`, fx.Name), slot)
		h.Dispatch(slot, "cap:"+fx.Name, "error: not granted")
		return
	}
	res, ok, err := impl(fx.Arg)
	if err != nil {
		h.Dispatch(slot, "cap:"+fx.Name, "error: "+err.Error())
	} else if ok {
		h.Dispatch(slot, "cap:"+fx.Name, res)
	}
}

// revert replaces a failed slot with its newest previous version whose schema matches the stored
// data (SPEC 6.1); with none, it restarts the same version. Returns whether it reverted.
func (h *Host) revert(slotName string, cause error) bool {
	sl := h.slots[slotName]
	if sl == nil {
		return false
	}
	sl.in.kill("failed")
	stored, hasStored := h.KV.Get(hostKeys + slotName)
	prev := sl.prev
	for len(prev) > 0 {
		back, rest := prev[0], prev[1:]
		in, err := h.load(slotName, back, h.keyRules[slotName])
		if err != nil {
			prev = rest
			continue
		}
		if hasStored && float64(in.schema) != num(stored, math.NaN()) {
			in.kill("schema mismatch")
			h.log("error", fmt.Sprintf("%s: not reverting to %s: it expects schema %d, but the data is on schema %s", slotName, back[:8], in.schema, valueString(stored)), slotName)
			prev = rest
			continue
		}
		h.slots[slotName] = &slot{hash: back, in: in, prev: rest}
		h.log("rollback", fmt.Sprintf("%s failed (%s) — reverted to %s", slotName, cause.Error(), back[:8]), slotName)
		return true
	}
	in := sl.in
	if fresh, err := h.load(slotName, sl.hash, h.keyRules[slotName]); err == nil {
		in = fresh
	}
	h.slots[slotName] = &slot{hash: sl.hash, in: in, prev: []string{}}
	h.log("error", fmt.Sprintf("%s: %s (no previous version to revert to)", slotName, cause.Error()), slotName)
	return false
}

// SetBound writes an input bound to state (SPEC section 8). shared/ keys are server-owned.
func (h *Host) SetBound(key, value string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if strings.HasPrefix(key, "shared/") {
		h.log("error", "input bound to "+key+": shared/ is owned by the server host; dropped", "")
		return
	}
	h.KV.Set(key, value)
}
