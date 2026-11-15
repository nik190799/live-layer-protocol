package llp

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

// LayerError is any failure of layer code: a trap, a sandbox limit, or an ABI misuse.
type LayerError struct{ Msg string }

func (e *LayerError) Error() string           { return e.Msg }
func layerErr(f string, a ...any) *LayerError { return &LayerError{fmt.Sprintf(f, a...)} }

// Node is one UI element (SPEC section 8). Its wire form is {"k","a","c"}; text is {"k":"text","t"}.
type Node struct {
	K string
	A map[string]string
	C []*Node
	T string
}

// JSON returns the node in its wire form, as plain values for Canonical.
func (n *Node) JSON() any {
	if n == nil {
		return nil
	}
	if n.K == "text" {
		return map[string]any{"k": "text", "t": n.T}
	}
	a := map[string]any{}
	for k, v := range n.A {
		a[k] = v
	}
	c := []any{}
	for _, ch := range n.C {
		c = append(c, ch.JSON())
	}
	return map[string]any{"k": n.K, "a": a, "c": c}
}

// Event is the current event of an llp_event call.
type Event struct{ ID, Value string }

// Effect is a capability request made with cap() (SPEC section 9).
type Effect struct{ Name, Arg string }

// keyRule is one slot's declared keys (SPEC 6.2).
type keyRule struct{ own, read []string }

func under(prefixes []string, k string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(k, p) {
			return true
		}
	}
	return false
}
func (r *keyRule) canRead(k string) bool { return r == nil || under(r.own, k) || under(r.read, k) }

// callState is everything one guest call can touch. Writes are buffered and only applied by the
// host if the call finishes cleanly (principle 6).
type callState struct {
	kv       KV
	rule     *keyRule
	writes   map[string]any
	order    []string
	stack    []*Node
	root     *Node
	nodes    int
	maxNodes int
	event    *Event
	effects  []Effect
	logs     []string
	now      func() float64
}

type callKey struct{}

func stateOf(ctx context.Context) *callState {
	st, _ := ctx.Value(callKey{}).(*callState)
	if st == nil {
		panic(layerErr("host call outside a host-initiated call"))
	}
	return st
}

func (st *callState) read(k string) (any, bool) {
	if v, ok := st.writes[k]; ok {
		return v, true
	}
	if !st.rule.canRead(k) { // a slot sees only the keys it owns or may read
		return nil, false
	}
	return st.kv.Get(k)
}
func (st *callState) write(k string, v any) {
	if _, ok := st.writes[k]; !ok {
		st.order = append(st.order, k)
	}
	st.writes[k] = v
}
func (st *callState) add(n *Node) {
	st.nodes++
	if st.nodes > st.maxNodes {
		panic(layerErr("UI exceeded %d nodes", st.maxNodes))
	}
	top := st.stack[len(st.stack)-1]
	top.C = append(top.C, n)
}

// decodeUTF8 replaces invalid bytes with U+FFFD, like TextDecoder.
func decodeUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	for len(b) > 0 {
		r, n := utf8.DecodeRune(b)
		if r == utf8.RuneError && n == 1 {
			sb.WriteRune(utf8.RuneError)
		} else {
			sb.Write(b[:n])
		}
		b = b[n:]
	}
	return sb.String()
}

func memStr(m api.Module, p, l uint32) string {
	b, ok := m.Memory().Read(p, l)
	if !ok {
		panic(layerErr("string out of bounds of layer memory"))
	}
	return decodeUTF8(b)
}
func memPut(m api.Module, s string, p, capacity uint32) uint32 {
	b := []byte(s)
	n := uint32(len(b))
	if n > capacity {
		n = capacity
	}
	if n > 0 && !m.Memory().Write(p, b[:n]) {
		panic(layerErr("buffer out of bounds of layer memory"))
	}
	return uint32(len(b))
}

// valueString is String(v) for a stored value.
func valueString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return NumberString(x)
	case bool:
		if x {
			return "true"
		}
		return "false"
	case nil:
		return ""
	}
	return fmt.Sprint(v)
}

// Engine owns the WebAssembly runtime and the LLP ABI imports (SPEC section 7) for one host.
type Engine struct {
	rt       wazero.Runtime
	compiled map[string]wazero.CompiledModule
	maxPages uint32
}

func newEngine(ctx context.Context, memoryMb int) (*Engine, error) {
	pages := uint32(memoryMb * (1 << 20) / 65536)
	rt := wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfig().WithMemoryLimitPages(pages).WithCloseOnContextDone(true))
	e := &Engine{rt: rt, compiled: map[string]wazero.CompiledModule{}, maxPages: pages}
	b := rt.NewHostModuleBuilder("llp")
	fn := func(name string, f any) { b.NewFunctionBuilder().WithFunc(f).Export(name) }
	fn("ui_begin", func(ctx context.Context, m api.Module, p, l uint32) {
		st := stateOf(ctx)
		n := &Node{K: memStr(m, p, l), A: map[string]string{}}
		st.add(n)
		st.stack = append(st.stack, n)
	})
	fn("ui_attr", func(ctx context.Context, m api.Module, kp, kl, vp, vl uint32) {
		st := stateOf(ctx)
		st.stack[len(st.stack)-1].A[memStr(m, kp, kl)] = memStr(m, vp, vl)
	})
	fn("ui_text", func(ctx context.Context, m api.Module, p, l uint32) {
		st := stateOf(ctx)
		st.add(&Node{K: "text", T: memStr(m, p, l)})
	})
	fn("ui_end", func(ctx context.Context) {
		st := stateOf(ctx)
		if len(st.stack) <= 1 {
			panic(layerErr("ui_end without ui_begin"))
		}
		st.stack = st.stack[:len(st.stack)-1]
	})
	fn("kv_get_n", func(ctx context.Context, m api.Module, kp, kl uint32, def float64) float64 {
		v, ok := stateOf(ctx).read(memStr(m, kp, kl))
		if f, isNum := v.(float64); ok && isNum {
			return f
		}
		return def
	})
	fn("kv_set_n", func(ctx context.Context, m api.Module, kp, kl uint32, v float64) {
		stateOf(ctx).write(memStr(m, kp, kl), v)
	})
	fn("kv_get_s", func(ctx context.Context, m api.Module, kp, kl, bp, capacity uint32) uint32 {
		v, _ := stateOf(ctx).read(memStr(m, kp, kl))
		return memPut(m, valueString(v), bp, capacity)
	})
	fn("kv_set_s", func(ctx context.Context, m api.Module, kp, kl, vp, vl uint32) {
		stateOf(ctx).write(memStr(m, kp, kl), memStr(m, vp, vl))
	})
	fn("ev_id", func(ctx context.Context, m api.Module, bp, capacity uint32) uint32 {
		st := stateOf(ctx)
		s := ""
		if st.event != nil {
			s = st.event.ID
		}
		return memPut(m, s, bp, capacity)
	})
	fn("ev_val", func(ctx context.Context, m api.Module, bp, capacity uint32) uint32 {
		st := stateOf(ctx)
		s := ""
		if st.event != nil {
			s = st.event.Value
		}
		return memPut(m, s, bp, capacity)
	})
	fn("cap", func(ctx context.Context, m api.Module, np, nl, ap, al uint32) uint32 {
		st := stateOf(ctx)
		st.effects = append(st.effects, Effect{Name: memStr(m, np, nl), Arg: memStr(m, ap, al)})
		return uint32(len(st.effects))
	})
	fn("log", func(ctx context.Context, m api.Module, p, l uint32) {
		st := stateOf(ctx)
		if len(st.logs) < 100 {
			st.logs = append(st.logs, memStr(m, p, l))
		}
	})
	fn("now", func(ctx context.Context) float64 { return stateOf(ctx).now() })
	if _, err := b.Instantiate(ctx); err != nil {
		return nil, err
	}
	env := rt.NewHostModuleBuilder("env")
	env.NewFunctionBuilder().WithFunc(func(ctx context.Context, a, b, c, d uint32) { panic(layerErr("layer aborted")) }).Export("abort")
	env.NewFunctionBuilder().WithFunc(func() float64 { return rand.Float64() * (1 << 32) }).Export("seed")
	if _, err := env.Instantiate(ctx); err != nil {
		return nil, err
	}
	return e, nil
}

func (e *Engine) Close() { e.rt.Close(context.Background()) }

// instance is one loaded layer (the Go host's counterpart of a worker: wazero sandboxes linear
// memory, and a context deadline stops a call that runs past its time limit).
type instance struct {
	mod        api.Module
	schema     int32
	hasView    bool
	hasMigrate bool
	dead       string
	calls      int
	rule       *keyRule
}

func (in *instance) kill(why string) {
	if in.dead == "" {
		in.dead = why
		if in.mod != nil {
			in.mod.Close(context.Background())
		}
	}
}

// memoryProblem reads the module's memory section: the spec's memory cap means a module whose
// initial memory is above the cap is refused at load, and 64-bit memories are refused.
func memoryProblem(b []byte, maxPages uint32) error {
	if len(b) < 8 || b[0] != 0 || b[1] != 'a' || b[2] != 's' || b[3] != 'm' {
		return layerErr("not a wasm module")
	}
	u32 := func(o int) (uint32, int) {
		var r uint32
		var sh uint
		for o < len(b) {
			x := b[o]
			o++
			r |= uint32(x&0x7f) << sh
			sh += 7
			if x&0x80 == 0 {
				break
			}
		}
		return r, o
	}
	o := 8
	for o < len(b) {
		id := b[o]
		size, body := u32(o + 1)
		if id == 5 {
			count, p := u32(body)
			for i := uint32(0); i < count && p < len(b); i++ {
				flags := b[p]
				p++
				if flags&0x04 != 0 {
					return layerErr("64-bit memory is not supported")
				}
				var minP uint32
				minP, p = u32(p)
				if flags&1 != 0 {
					_, p = u32(p)
				}
				if minP > maxPages {
					return layerErr("layer asks for %d MB of memory at start; limit is %d MB", minP*65536>>20, maxPages*65536>>20)
				}
			}
			return nil
		}
		o = body + int(size)
	}
	return nil
}

func (e *Engine) load(ctx context.Context, hash string, bytes []byte, headless bool, loadMs int, now func() float64) (*instance, []string, error) {
	if err := memoryProblem(bytes, e.maxPages); err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(loadMs)*time.Millisecond)
	defer cancel()
	cm, ok := e.compiled[hash]
	if !ok {
		var err error
		cm, err = e.rt.CompileModule(ctx, bytes)
		if err != nil {
			return nil, nil, layerErr("compile: %v", err)
		}
		e.compiled[hash] = cm
	}
	mems := cm.ExportedMemories()
	if _, ok := mems["memory"]; !ok {
		return nil, nil, layerErr("layer must export memory")
	}
	fns := cm.ExportedFunctions()
	if _, ok := fns["llp_view"]; !ok && !headless {
		return nil, nil, layerErr("layer must export llp_view")
	}
	// A start function may call imports; give it a call state so it can't reach the host's real state.
	st := &callState{kv: NewStore(), writes: map[string]any{}, root: &Node{K: "root"}, maxNodes: 0, now: now}
	st.stack = []*Node{st.root}
	cctx := context.WithValue(ctx, callKey{}, st)
	mod, err := e.rt.InstantiateModule(cctx, cm, wazero.NewModuleConfig().WithName("").WithStartFunctions())
	if err != nil {
		return nil, st.logs, wrapCallErr(ctx, err, loadMs, "load")
	}
	in := &instance{mod: mod}
	_, in.hasView = fns["llp_view"]
	_, in.hasMigrate = fns["llp_migrate"]
	if f := mod.ExportedFunction("llp_schema"); f != nil {
		r, err := f.Call(cctx)
		if err != nil {
			mod.Close(context.Background())
			return nil, st.logs, wrapCallErr(ctx, err, loadMs, "llp_schema")
		}
		if len(r) > 0 {
			in.schema = api.DecodeI32(r[0])
		}
	}
	return in, st.logs, nil
}

func wrapCallErr(ctx context.Context, err error, ms int, fn string) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return layerErr("%s ran past its %d ms time limit; layer killed", fn, ms)
	}
	var le *LayerError
	if errors.As(err, &le) {
		return le
	}
	// wazero wraps host panics; keep the layer's own message when it is one of ours.
	msg := err.Error()
	return layerErr("%s", strings.TrimSpace(strings.SplitN(msg, "\nwasm stack trace", 2)[0]))
}

// result of one guest call
type callResult struct {
	tree    *Node
	effects []Effect
	writes  []kvPair
	logs    []string
}
type kvPair struct {
	k string
	v any
}

func (e *Engine) call(ctx context.Context, in *instance, fn string, kv KV, ev *Event, args []uint64, ms, maxNodes int, now func() float64) (*callResult, error) {
	if in.dead != "" {
		return nil, layerErr("layer is dead (%s)", in.dead)
	}
	st := &callState{kv: kv, rule: in.rule, writes: map[string]any{}, root: &Node{K: "root", A: map[string]string{}}, maxNodes: maxNodes, event: ev, now: now}
	st.stack = []*Node{st.root}
	f := in.mod.ExportedFunction(fn)
	res := &callResult{}
	if f != nil {
		cctx, cancel := context.WithTimeout(ctx, time.Duration(ms)*time.Millisecond)
		_, err := f.Call(context.WithValue(cctx, callKey{}, st), args...)
		timedOut := errors.Is(cctx.Err(), context.DeadlineExceeded)
		cancel()
		res.logs = st.logs
		if err != nil {
			if timedOut {
				in.kill("time limit")
				return res, layerErr("ran past its %d ms time limit; layer killed", ms)
			}
			in.kill("trapped")
			return res, wrapCallErr(context.Background(), err, ms, fn)
		}
		if len(st.stack) != 1 {
			return res, layerErr("unbalanced UI in %s", fn)
		}
	}
	if len(st.root.C) == 1 {
		res.tree = st.root.C[0]
	} else {
		res.tree = st.root
	}
	res.effects = st.effects
	for _, k := range st.order {
		res.writes = append(res.writes, kvPair{k, st.writes[k]})
	}
	return res, nil
}
