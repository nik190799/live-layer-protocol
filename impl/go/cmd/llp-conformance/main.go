// llp-conformance runs the shared LLP conformance vectors against the Go host.
//
//	go run ./cmd/llp-conformance [-v] [-only text] ../../conformance
//
// The JavaScript reference host runs the same files: node conformance/run-js.mjs
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/nik190799/live-layer-protocol/impl/go/llp"
)

var (
	pass, failN int
	verbose     = flag.Bool("v", false, "print passing checks too")
	only        = flag.String("only", "", "run only scenarios whose name contains this")
)

func check(name string, ok bool, detail string) {
	if ok {
		pass++
	} else {
		failN++
	}
	if !ok || *verbose {
		s := "PASS"
		if !ok {
			s = "FAIL"
		}
		if !ok && detail != "" {
			fmt.Printf("%s  %s  — %s\n", s, name, detail)
		} else {
			fmt.Printf("%s  %s\n", s, name)
		}
	}
}

func must[T any](v T, err error) T {
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(2)
	}
	return v
}

func canon(v any) string {
	s, err := llp.Canonical(v)
	if err != nil {
		return "<" + err.Error() + ">"
	}
	return s
}
func eq(a, b any) bool { return canon(a) == canon(b) }

func obj(v any) map[string]any { m, _ := v.(map[string]any); return m }
func arr(v any) []any          { a, _ := v.([]any); return a }
func str(v any) string         { s, _ := v.(string); return s }

func main() {
	flag.Parse()
	dir := "conformance"
	if flag.NArg() > 0 {
		dir = flag.Arg(0)
	}
	load := func(n string) any {
		return must(llp.ParseJSON(must(os.ReadFile(filepath.Join(dir, "vectors", n+".json")))))
	}
	keysDoc := obj(must(llp.ParseJSON(must(os.ReadFile(filepath.Join(dir, "keys.json"))))))
	pub := func(name string) *llp.PublicKey { return must(llp.ParseJWK(obj(keysDoc[name])["public"])) }
	buildDir := filepath.Join(dir, "..", "build")
	files := map[string]string{}
	for _, e := range must(os.ReadDir(buildDir)) {
		if strings.HasSuffix(e.Name(), ".wasm") {
			files[llp.SHA256Hex(must(os.ReadFile(filepath.Join(buildDir, e.Name()))))] = e.Name()
		}
	}
	blobOf := func(f string) []byte { return must(os.ReadFile(filepath.Join(buildDir, f))) }

	// ---------- canonical ----------
	for _, v := range arr(load("canonical")) {
		c := obj(v)
		name := "canonical: " + str(c["name"])
		parsed, err := llp.ParseJSON([]byte(str(c["json"])))
		var got string
		if err == nil {
			got, err = llp.Canonical(parsed)
		}
		if c["error"] == true {
			check(name, err != nil, "got "+got)
		} else {
			check(name, err == nil && got == str(c["canonical"]), fmt.Sprintf("got %s %v", got, err))
		}
	}

	// ---------- crypto ----------
	cr := obj(load("crypto"))
	for _, v := range arr(cr["sha256"]) {
		c := obj(v)
		var b []byte
		if f := str(c["file"]); f != "" {
			b = blobOf(f)
		} else {
			h := str(c["hex"])
			for i := 0; i+1 < len(h); i += 2 {
				var x byte
				fmt.Sscanf(h[i:i+2], "%02x", &x)
				b = append(b, x)
			}
		}
		check("sha256: "+str(c["name"]), llp.SHA256Hex(b) == str(c["sha256"]), "")
	}
	for _, v := range arr(cr["keyId"]) {
		c := obj(v)
		k, err := llp.ParseJWK(c["jwk"])
		check("keyId: "+str(c["name"]), err == nil && k.KeyID() == str(c["kid"]), "")
	}
	for _, v := range arr(cr["verify"]) {
		c := obj(v)
		doc := c["doc"]
		if j := str(c["docJson"]); j != "" {
			doc = must(llp.ParseJSON([]byte(j)))
		}
		got := false
		if k, err := llp.ParseJWK(c["jwk"]); err == nil {
			got = k.Verify(doc, str(c["sig"]))
		}
		check("verify: "+str(c["name"]), got == (c["valid"] == true), fmt.Sprintf("got %v", got))
	}
	for _, v := range arr(cr["bucket"]) {
		c := obj(v)
		got := llp.Bucket(str(c["host"]), str(c["seed"]))
		check(fmt.Sprintf("bucket: %q / %s", str(c["host"]), str(c["seed"])), float64(got) == c["bucket"], fmt.Sprintf("got %d", got))
	}

	// ---------- scenarios ----------
	for _, v := range arr(load("scenarios")) {
		sc := obj(v)
		if *only != "" && !strings.Contains(str(sc["name"]), *only) {
			continue
		}
		runScenario(sc, pub, files, blobOf)
	}

	// ---------- keyrings ----------
	for _, v := range arr(load("keyrings")) {
		c := obj(v)
		t, err := llp.NewTrustStore(c["pinned"])
		ok, why := err == nil, []string{}
		for i, s := range arr(c["steps"]) {
			if t == nil {
				break
			}
			st := obj(s)
			got, reason := t.Update(st["doc"], st["sigs"])
			if got != (st["ok"] == true) {
				ok = false
				why = append(why, fmt.Sprintf("step %d: ok=%v (%s)", i+1, got, reason))
			}
		}
		if ra := arr(c["releaseAfter"]); ra != nil && t != nil {
			got := []any{}
			for _, k := range t.ReleaseKeys() {
				got = append(got, k.KeyID())
			}
			if !eq(got, ra) {
				ok = false
				why = append(why, "release keys "+canon(got))
			}
		}
		check("keyring: "+str(c["name"]), ok, strings.Join(why, "; "))
	}

	// ---------- fleet ----------
	for _, v := range arr(load("fleet")) {
		c := obj(v)
		now := c["now"].(float64)
		host := must(llp.NewHost(llp.Options{Now: func() float64 { return now }}))
		trust := must(llp.NewTrustStore(c["keyring"]))
		dev := must(llp.GenerateKey())
		var sent []map[string]any
		var agent *llp.Agent
		agent = llp.NewAgent(host, str(c["id"]), str(c["channel"]), trust, dev, func(m map[string]any) {
			sent = append(sent, m)
			if m["t"] == "want" {
				for _, h := range arr(m["hashes"]) {
					data := ""
					if f := files[str(h)]; f != "" {
						data = llp.B64Encode(blobOf(f))
					}
					agent.Receive(map[string]any{"t": "blob", "hash": h, "data": data})
				}
			}
		})
		for i, s := range arr(c["steps"]) {
			st := obj(s)
			before := len(sent)
			agent.Receive(obj(st["msg"]))
			var r map[string]any
			n := 0
			for _, m := range sent[before:] {
				if m["t"] == "status" {
					r, n = m, n+1
				}
			}
			ok := false
			if st["state"] == nil {
				ok = n == 0
			} else {
				ok = r != nil && r["state"] == st["state"]
			}
			if ok && st["code"] != nil {
				ok = r["code"] == st["code"]
			}
			if ok && st["version"] != nil {
				ok = host.Version == st["version"].(float64)
			}
			got := "null"
			if r != nil {
				got = canon(map[string]any{"state": r["state"], "code": r["code"], "reason": r["reason"]})
			}
			check(fmt.Sprintf("fleet: %s [step %d]", str(c["name"]), i+1), ok, fmt.Sprintf("got %s version %s", got, llp.NumberString(host.Version)))
		}
		host.Close()
	}

	fmt.Printf("\nGo host: %d passed, %d failed\n", pass, failN)
	if failN > 0 {
		os.Exit(1)
	}
}

func textOf(n *llp.Node) []string {
	if n == nil {
		return nil
	}
	if n.K == "text" {
		return []string{n.T}
	}
	out := []string{}
	for _, c := range n.C {
		out = append(out, textOf(c)...)
	}
	return out
}

func runScenario(sc map[string]any, pub func(string) *llp.PublicKey, files map[string]string, blobOf func(string) []byte) {
	cfg := obj(sc["host"])
	now := cfg["now"].(float64)
	var calls []any
	caps := map[string]llp.Capability{}
	for name, cv := range obj(cfg["caps"]) {
		c, name := obj(cv), name
		caps[name] = func(arg string) (string, bool, error) {
			calls = append(calls, []any{name, arg})
			if e, ok := c["error"].(string); ok {
				return "", false, errors.New(e)
			}
			if c["none"] == true {
				return "", false, nil
			}
			return str(c["result"]), true, nil
		}
	}
	var keys []*llp.PublicKey
	for _, k := range arr(cfg["keys"]) {
		keys = append(keys, pub(str(k)))
	}
	var last []llp.SlotView
	host := must(llp.NewHost(llp.Options{App: str(cfg["app"]), TrustedKeys: keys, AllowUnsigned: cfg["allowUnsigned"] == true, Capabilities: caps,
		OnRender: func(v []llp.SlotView) { last = v }, Now: func() float64 { return now }}))
	defer host.Close()
	if me, ok := cfg["maxEpoch"].(float64); ok {
		host.MaxEpoch = me
	}
	for i, s := range arr(sc["steps"]) {
		st := obj(s)
		label := fmt.Sprintf("scenario: %s [step %d %s]", str(sc["name"]), i+1, str(st["op"]))
		switch st["op"] {
		case "apply":
			m := st["manifest"]
			if j := str(st["manifestJson"]); j != "" {
				m = must(llp.ParseJSON([]byte(j)))
			}
			var fetched []any
			serve := obj(st["serve"])
			r := host.Apply(m, str(st["sig"]), func(h string) ([]byte, error) {
				fetched = append(fetched, h)
				f := str(serve[h])
				if f == "" {
					f = files[h]
				}
				if f == "" {
					return nil, nil
				}
				return blobOf(f), nil
			})
			e := obj(st["expect"])
			ok := r.OK == (e["ok"] == true) && (e["code"] == nil || r.Code == e["code"])
			sortAny := func(a []any) []any {
				out := append([]any{}, a...)
				sort.Slice(out, func(i, j int) bool { return str(out[i]) < str(out[j]) })
				return out
			}
			if sw := arr(e["swapped"]); sw != nil {
				got := []any{}
				for _, x := range r.Swapped {
					got = append(got, x)
				}
				ok = ok && eq(sortAny(got), sortAny(sw))
			}
			if fe := arr(e["fetched"]); fe != nil {
				if fetched == nil {
					fetched = []any{}
				}
				ok = ok && eq(sortAny(fetched), sortAny(fe))
			}
			short := []string{}
			for _, h := range fetched {
				short = append(short, str(h)[:8])
			}
			check(label, ok, fmt.Sprintf("got ok=%v code=%s reason=%q swapped=%v fetched=%v", r.OK, r.Code, r.Reason, r.Swapped, short))
		case "bind":
			host.SetBound(str(st["key"]), str(st["value"]))
		case "event":
			host.Dispatch(str(st["slot"]), str(st["id"]), str(st["value"]))
		case "expect":
			var bad []string
			snap := host.KV.Snapshot()
			for _, k := range llp.SortedKeys(obj(st["state"])) {
				want := obj(st["state"])[k]
				got, has := snap[k]
				if want == nil && has || want != nil && (!has || !eq(got, want)) {
					bad = append(bad, fmt.Sprintf("state %s=%s want %s", k, canon(got), canon(want)))
				}
			}
			run := host.Running()
			for k, want := range obj(st["running"]) {
				got, has := run[k]
				if want == nil && has || want != nil && got != want {
					bad = append(bad, fmt.Sprintf("running %s=%.8s want %.8s", k, got, str(want)))
				}
			}
			if v, ok := st["version"].(float64); ok && host.Version != v {
				bad = append(bad, fmt.Sprintf("version %s want %s", llp.NumberString(host.Version), llp.NumberString(v)))
			}
			if v, ok := st["epoch"].(float64); ok && host.Epoch != v {
				bad = append(bad, fmt.Sprintf("epoch %s want %s", llp.NumberString(host.Epoch), llp.NumberString(v)))
			}
			if v, ok := st["rollbacks"].(float64); ok {
				n := 0
				for _, h := range host.History {
					if h.Kind == "rollback" {
						n++
					}
				}
				if float64(n) != v {
					bad = append(bad, fmt.Sprintf("rollbacks %d want %s", n, llp.NumberString(v)))
				}
			}
			if rs := arr(st["renders"]); rs != nil {
				got := []any{}
				for _, v := range last {
					got = append(got, v.Slot)
				}
				if !eq(got, rs) {
					bad = append(bad, fmt.Sprintf("renders %s want %s", canon(got), canon(rs)))
				}
			}
			if cc, has := st["capsCalled"]; has {
				got := calls
				if got == nil {
					got = []any{}
				}
				if !eq(got, cc) {
					bad = append(bad, fmt.Sprintf("caps %s want %s", canon(got), canon(cc)))
				}
			}
			for _, field := range []string{"text", "views"} {
				for slot, want := range obj(st[field]) {
					var got any
					for _, v := range last {
						if v.Slot == slot {
							if v.Error != "" {
								got = map[string]any{"error": true}
							} else if field == "text" {
								got = strings.Join(textOf(v.Tree), "|")
							} else {
								got = v.Tree.JSON()
							}
						}
					}
					if !eq(got, want) {
						bad = append(bad, fmt.Sprintf("%s.%s=%s want %s", field, slot, canon(got), canon(want)))
					}
				}
			}
			check(label, len(bad) == 0, strings.Join(bad, "; "))
		}
	}
	_ = time.Now
}
