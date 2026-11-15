// llp-host: the Go Live Host, headless. Speaks SPEC section 5 to a publisher, or section 12 to a
// fleet controller. Prints one JSON object per line (renders, logs, acks, status reports).
//
//	llp-host --key publisher.pub.json [--app demo.tasks] ws://localhost:7700
//	llp-host --fleet keyring.pinned.json --id host-1 --channel stable [--trust-dir DIR | --no-trust-dir] [--freshness warn|refuse] ws://localhost:7720
//
// stdin: "click <slot> <id> [value]", "set <key> <text>", "state", "render".
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/nik190799/live-layer-protocol/impl/go/llp"
)

var outMu sync.Mutex

func emit(v map[string]any) {
	outMu.Lock()
	defer outMu.Unlock()
	fmt.Println(llp.MustCanonical(v))
}

func readJSON(file string) any {
	b, err := os.ReadFile(file)
	if err != nil {
		fail("can't read %s: %v", file, err)
	}
	v, err := llp.ParseJSON(b)
	if err != nil {
		fail("can't parse %s: %v", file, err)
	}
	return v
}

func fail(f string, a ...any) { fmt.Fprintf(os.Stderr, "error: "+f+"\n", a...); os.Exit(2) }

func writeAtomic(file string, v any) {
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, []byte(llp.MustCanonical(v)), 0o600); err == nil {
		os.Rename(tmp, file)
	}
}

func views(vs []llp.SlotView) []any {
	out := []any{}
	for _, v := range vs {
		if v.Error != "" {
			out = append(out, map[string]any{"slot": v.Slot, "error": v.Error})
		} else {
			out = append(out, map[string]any{"slot": v.Slot, "tree": v.Tree.JSON()})
		}
	}
	return out
}

// conn is one WebSocket link with serialised writes.
type conn struct {
	mu sync.Mutex
	c  *websocket.Conn
}

func (c *conn) send(m map[string]any) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c.c.Write(ctx, websocket.MessageText, []byte(llp.MustCanonical(m)))
}

func dial(url string) (*conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		return nil, err
	}
	c.SetReadLimit(64 << 20)
	return &conn{c: c}, nil
}

func (c *conn) read() (map[string]any, error) {
	_, b, err := c.c.Read(context.Background())
	if err != nil {
		return nil, err
	}
	v, err := llp.ParseJSON(b)
	if err != nil {
		return map[string]any{}, nil
	}
	m, _ := v.(map[string]any)
	if m == nil {
		m = map[string]any{}
	}
	return m, nil
}

func main() {
	keyFile := flag.String("key", "", "trusted publisher public key (JWK file), for a plain host")
	app := flag.String("app", "demo.tasks", "the app this host runs")
	fleet := flag.String("fleet", "", "pinned keyring file: join a fleet controller instead of a publisher")
	id := flag.String("id", "host", "fleet host id")
	channel := flag.String("channel", "stable", "fleet channel")
	trustDir := flag.String("trust-dir", "", "where the latest keyring and the device key are kept (default: trust/ beside the keyring)")
	noTrust := flag.Bool("no-trust-dir", false, "keep nothing on disk (tests only)")
	freshness := flag.String("freshness", "", "warn | refuse")
	quiet := flag.Bool("quiet-render", false, "don't print renders")
	flag.Parse()
	if flag.NArg() != 1 {
		fail("usage: llp-host [--key pub.json | --fleet keyring.json --id ID --channel NAME] ws://host:port")
	}
	url := flag.Arg(0)

	opt := llp.Options{
		App: *app,
		Capabilities: map[string]llp.Capability{
			"haptic": func(string) (string, bool, error) { return "", false, nil },
			"geo":    func(string) (string, bool, error) { return "location unavailable on this host (headless)", true, nil },
		},
		OnLog: func(e llp.LogEntry) { emit(map[string]any{"ev": "log", "kind": e.Kind, "msg": e.Msg, "slot": e.Slot}) },
	}
	if !*quiet {
		opt.OnRender = func(vs []llp.SlotView) { emit(map[string]any{"ev": "render", "slots": views(vs)}) }
	}
	if *fleet == "" {
		if *keyFile == "" {
			fail("a plain host needs --key (a host with no trusted keys refuses everything)")
		}
		k, err := llp.ParseJWK(readJSON(*keyFile))
		if err != nil {
			fail("%s: %v", *keyFile, err)
		}
		opt.TrustedKeys = []*llp.PublicKey{k}
	} else {
		opt.App = ""
	}
	host, err := llp.NewHost(opt)
	if err != nil {
		fail("%v", err)
	}
	var cur *conn
	var curMu sync.Mutex
	send := func(m map[string]any) {
		curMu.Lock()
		c := cur
		curMu.Unlock()
		c.send(m)
	}

	if *fleet == "" {
		go runPublisherLink(url, host, func(c *conn) { curMu.Lock(); cur = c; curMu.Unlock() }, send)
	} else {
		go runFleet(url, host, *fleet, *id, *channel, *trustDir, *noTrust, *freshness, func(c *conn) { curMu.Lock(); cur = c; curMu.Unlock() }, send)
	}

	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 0 {
			continue
		}
		switch f[0] {
		case "click":
			if len(f) >= 3 {
				host.Dispatch(f[1], f[2], strings.Join(f[3:], " "))
			}
		case "set":
			if len(f) >= 2 {
				host.SetBound(f[1], strings.Join(f[2:], " "))
				host.Render()
			}
		case "render":
			emit(map[string]any{"ev": "render", "slots": views(host.Render())})
		case "state":
			emit(map[string]any{"ev": "state", "version": host.Version, "epoch": host.Epoch, "kv": host.KV.Snapshot(), "running": anyMap(host.Running())})
		}
	}
	select {} // stdin closed: keep serving
}

func anyMap(m map[string]string) map[string]any {
	out := map[string]any{}
	for k, v := range m {
		out[k] = v
	}
	return out
}

// SPEC section 5: hello, manifest, want/blob, ack/nack.
func runPublisherLink(url string, host *llp.Host, setConn func(*conn), send func(map[string]any)) {
	var pmu sync.Mutex
	pending := map[string]chan []byte{}
	manifests := make(chan map[string]any, 64)
	go func() {
		for msg := range manifests {
			sig, _ := msg["sig"].(string)
			r := host.Apply(msg["manifest"], sig, func(h string) ([]byte, error) {
				ch := make(chan []byte, 1)
				pmu.Lock()
				pending[h] = ch
				pmu.Unlock()
				send(map[string]any{"t": "want", "hashes": []any{h}})
				select {
				case b := <-ch:
					return b, nil
				case <-time.After(10 * time.Second):
					return nil, fmt.Errorf("timeout")
				}
			})
			if r.OK {
				send(map[string]any{"t": "ack", "version": r.Version, "ms": r.Ms, "running": anyMap(host.Running())})
				emit(map[string]any{"ev": "ack", "version": r.Version, "ms": r.Ms})
			} else {
				send(map[string]any{"t": "nack", "version": r.Version, "code": r.Code, "reason": r.Reason})
				emit(map[string]any{"ev": "nack", "version": r.Version, "code": r.Code, "reason": r.Reason})
			}
		}
	}()
	for {
		c, err := dial(url)
		if err != nil {
			time.Sleep(500 * time.Millisecond)
			continue
		}
		setConn(c)
		emit(map[string]any{"ev": "connected", "url": url})
		have := []any{}
		for _, h := range host.HaveBlobs() {
			have = append(have, h)
		}
		send(map[string]any{"t": "hello", "llp": float64(llp.LLPVersion), "app": host.App, "version": host.Version, "have": have})
		for {
			msg, err := c.read()
			if err != nil {
				break
			}
			switch msg["t"] {
			case "manifest":
				manifests <- msg
			case "blob":
				h, _ := msg["hash"].(string)
				d, _ := msg["data"].(string)
				pmu.Lock()
				ch := pending[h]
				delete(pending, h)
				pmu.Unlock()
				if b, err := llp.B64Decode(d); ch != nil && err == nil {
					ch <- b
				}
			}
		}
		emit(map[string]any{"ev": "closed"})
		time.Sleep(500 * time.Millisecond)
	}
}

var unsafeChars = regexp.MustCompile(`[^\w.-]`)

func runFleet(url string, host *llp.Host, pinnedFile, id, channel, trustDir string, noTrust bool, freshness string, setConn func(*conn), send func(map[string]any)) {
	pinned := readJSON(pinnedFile)
	if !noTrust && trustDir == "" {
		trustDir = filepath.Join(filepath.Dir(pinnedFile), "trust")
	}
	safe := unsafeChars.ReplaceAllString(id, "_")
	doc := pinned
	var keyringFile, deviceFile string
	if !noTrust {
		os.MkdirAll(trustDir, 0o700)
		keyringFile = filepath.Join(trustDir, safe+".keyring.json")
		deviceFile = filepath.Join(trustDir, safe+".device.json")
		// A saved file that exists but can't be read stops the host (falling back would undo a revocation).
		if _, err := os.Stat(keyringFile); err == nil {
			saved := readJSON(keyringFile).(map[string]any)
			p := pinned.(map[string]any)
			if saved["app"] == p["app"] && saved["keyring"].(float64) > p["keyring"].(float64) {
				doc = saved
			}
		}
	}
	trust, err := llp.NewTrustStore(doc)
	if err != nil {
		fail("keyring: %v", err)
	}
	var dev *llp.PrivateKey
	if deviceFile != "" {
		if _, err := os.Stat(deviceFile); err == nil {
			saved := readJSON(deviceFile).(map[string]any)
			if dev, err = llp.ParsePrivateJWK(saved["private"]); err != nil {
				fail("%s: %v", deviceFile, err)
			}
		}
	}
	if dev == nil {
		dev, _ = llp.GenerateKey()
		if deviceFile != "" {
			writeAtomic(deviceFile, map[string]any{"private": dev.PrivateJWK(), "public": dev.Pub.JWK})
		} else {
			fmt.Fprintln(os.Stderr, "warning: --no-trust-dir, so this host's device key and keyring are not kept across restarts")
		}
	}
	agent := llp.NewAgent(host, id, channel, trust, dev, func(m map[string]any) {
		if m["t"] == "status" {
			out := map[string]any{"ev": "status"}
			for k, v := range m {
				out[k] = v
			}
			emit(out)
		}
		send(m)
	})
	agent.Freshness = freshness
	if keyringFile != "" {
		agent.OnKeyring = func(d map[string]any) { writeAtomic(keyringFile, d) }
	}
	if freshness != "" {
		go func() {
			for range time.Tick(30 * time.Second) {
				agent.CheckFreshness()
			}
		}()
	}
	queue := make(chan map[string]any, 256)
	go func() {
		for m := range queue {
			agent.Receive(m)
		}
	}()
	for {
		c, err := dial(url)
		if err != nil {
			time.Sleep(500 * time.Millisecond)
			continue
		}
		agent.Connected()
		setConn(c)
		emit(map[string]any{"ev": "connected", "url": url})
		for {
			msg, err := c.read()
			if err != nil {
				break
			}
			switch msg["t"] {
			case "blob", "challenge": // answered at once, so a pending apply can receive its blobs
				agent.Receive(msg)
			default:
				queue <- msg
			}
		}
		emit(map[string]any{"ev": "closed"})
		time.Sleep(500 * time.Millisecond)
	}
}
