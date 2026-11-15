package llp

// KV is host state: string keys, values that are float64 or string (SPEC section 3.1).
type KV interface {
	Get(k string) (any, bool)
	Set(k string, v any)
	Delete(k string)
	Len() int
}

// Store is the host-owned state that survives every swap.
type Store struct{ m map[string]any }

func NewStore() *Store                    { return &Store{m: map[string]any{}} }
func (s *Store) Get(k string) (any, bool) { v, ok := s.m[k]; return v, ok }
func (s *Store) Set(k string, v any)      { s.m[k] = v }
func (s *Store) Delete(k string)          { delete(s.m, k) }
func (s *Store) Len() int                 { return len(s.m) }
func (s *Store) Snapshot() map[string]any {
	out := make(map[string]any, len(s.m))
	for k, v := range s.m {
		out[k] = v
	}
	return out
}

// Shadow is a copy-on-write view used to stage a manifest (SPEC section 6 step 4): writes stay in
// the shadow, so staging costs O(keys written), and Commit replays them onto the parent in order.
type Shadow struct {
	parent KV
	writes map[string]shadowVal
	log    []string
}
type shadowVal struct {
	v    any
	gone bool
}

func NewShadow(parent KV) *Shadow { return &Shadow{parent: parent, writes: map[string]shadowVal{}} }
func (s *Shadow) Get(k string) (any, bool) {
	if w, ok := s.writes[k]; ok {
		return w.v, !w.gone
	}
	return s.parent.Get(k)
}
func (s *Shadow) Set(k string, v any) { s.writes[k] = shadowVal{v: v}; s.log = append(s.log, k) }
func (s *Shadow) Delete(k string)     { s.writes[k] = shadowVal{gone: true}; s.log = append(s.log, k) }
func (s *Shadow) Len() int {
	n := s.parent.Len()
	for k, w := range s.writes {
		_, had := s.parent.Get(k)
		if w.gone && had {
			n--
		} else if !w.gone && !had {
			n++
		}
	}
	return n
}
func (s *Shadow) Commit() {
	for _, k := range s.log {
		if w := s.writes[k]; w.gone {
			s.parent.Delete(k)
		} else {
			s.parent.Set(k, w.v)
		}
	}
}
