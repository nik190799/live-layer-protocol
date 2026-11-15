// Package llp is an independent implementation of the Live Layer Protocol host, written from
// SPEC.md. It shares no code with the JavaScript reference host.
package llp

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// JSON values are decoded into: nil, bool, float64, string, []any, map[string]any.
// Numbers are IEEE-754 doubles, as in every JSON peer the spec talks to (I-JSON, RFC 7493).

// ParseJSON parses strict JSON (RFC 8259). It refuses lone surrogate escapes and invalid UTF-8,
// because such strings have no canonical form (SPEC section 4, canonical JSON). Duplicate object
// keys: the last one wins (the behaviour of every mainstream parser).
func ParseJSON(b []byte) (any, error) {
	p := &parser{b: b}
	p.ws()
	v, err := p.value(0)
	if err != nil {
		return nil, err
	}
	p.ws()
	if p.i != len(p.b) {
		return nil, p.errf("trailing data")
	}
	return v, nil
}

type parser struct {
	b []byte
	i int
}

func (p *parser) errf(f string, a ...any) error {
	return fmt.Errorf("json: %s at offset %d", fmt.Sprintf(f, a...), p.i)
}
func (p *parser) ws() {
	for p.i < len(p.b) {
		switch p.b[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

func (p *parser) value(depth int) (any, error) {
	if depth > 512 {
		return nil, p.errf("nested too deeply")
	}
	if p.i >= len(p.b) {
		return nil, p.errf("unexpected end")
	}
	switch c := p.b[p.i]; {
	case c == '{':
		p.i++
		m := map[string]any{}
		p.ws()
		if p.i < len(p.b) && p.b[p.i] == '}' {
			p.i++
			return m, nil
		}
		for {
			p.ws()
			if p.i >= len(p.b) || p.b[p.i] != '"' {
				return nil, p.errf("expected object key")
			}
			k, err := p.str()
			if err != nil {
				return nil, err
			}
			p.ws()
			if p.i >= len(p.b) || p.b[p.i] != ':' {
				return nil, p.errf("expected ':'")
			}
			p.i++
			p.ws()
			v, err := p.value(depth + 1)
			if err != nil {
				return nil, err
			}
			m[k] = v
			p.ws()
			if p.i < len(p.b) && p.b[p.i] == ',' {
				p.i++
				continue
			}
			if p.i < len(p.b) && p.b[p.i] == '}' {
				p.i++
				return m, nil
			}
			return nil, p.errf("expected ',' or '}'")
		}
	case c == '[':
		p.i++
		a := []any{}
		p.ws()
		if p.i < len(p.b) && p.b[p.i] == ']' {
			p.i++
			return a, nil
		}
		for {
			p.ws()
			v, err := p.value(depth + 1)
			if err != nil {
				return nil, err
			}
			a = append(a, v)
			p.ws()
			if p.i < len(p.b) && p.b[p.i] == ',' {
				p.i++
				continue
			}
			if p.i < len(p.b) && p.b[p.i] == ']' {
				p.i++
				return a, nil
			}
			return nil, p.errf("expected ',' or ']'")
		}
	case c == '"':
		return p.str()
	case c == 't':
		return p.lit("true", true)
	case c == 'f':
		return p.lit("false", false)
	case c == 'n':
		return p.lit("null", nil)
	case c == '-' || (c >= '0' && c <= '9'):
		return p.num()
	}
	return nil, p.errf("unexpected character %q", p.b[p.i])
}

func (p *parser) lit(s string, v any) (any, error) {
	if !strings.HasPrefix(string(p.b[p.i:min(len(p.b), p.i+len(s))]), s) {
		return nil, p.errf("bad literal")
	}
	p.i += len(s)
	return v, nil
}

func (p *parser) num() (any, error) {
	st := p.i
	if p.b[p.i] == '-' {
		p.i++
	}
	digits := func() int {
		n := 0
		for p.i < len(p.b) && p.b[p.i] >= '0' && p.b[p.i] <= '9' {
			p.i++
			n++
		}
		return n
	}
	if p.i < len(p.b) && p.b[p.i] == '0' {
		p.i++
	} else if digits() == 0 {
		return nil, p.errf("bad number")
	}
	if p.i < len(p.b) && p.b[p.i] == '.' {
		p.i++
		if digits() == 0 {
			return nil, p.errf("bad number")
		}
	}
	if p.i < len(p.b) && (p.b[p.i] == 'e' || p.b[p.i] == 'E') {
		p.i++
		if p.i < len(p.b) && (p.b[p.i] == '+' || p.b[p.i] == '-') {
			p.i++
		}
		if digits() == 0 {
			return nil, p.errf("bad number")
		}
	}
	f, err := strconv.ParseFloat(string(p.b[st:p.i]), 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return nil, p.errf("bad number")
	}
	if math.IsInf(f, 0) {
		return nil, p.errf("number out of range")
	}
	return f, nil
}

func hex4(b []byte) (rune, bool) {
	if len(b) < 4 {
		return 0, false
	}
	v, err := strconv.ParseUint(string(b[:4]), 16, 32)
	return rune(v), err == nil
}

func (p *parser) str() (string, error) {
	p.i++ // opening quote
	var sb strings.Builder
	for {
		if p.i >= len(p.b) {
			return "", p.errf("unterminated string")
		}
		c := p.b[p.i]
		switch {
		case c == '"':
			p.i++
			return sb.String(), nil
		case c < 0x20:
			return "", p.errf("control character in string")
		case c == '\\':
			if p.i+1 >= len(p.b) {
				return "", p.errf("bad escape")
			}
			e := p.b[p.i+1]
			p.i += 2
			switch e {
			case '"', '\\', '/':
				sb.WriteByte(e)
			case 'b':
				sb.WriteByte('\b')
			case 'f':
				sb.WriteByte('\f')
			case 'n':
				sb.WriteByte('\n')
			case 'r':
				sb.WriteByte('\r')
			case 't':
				sb.WriteByte('\t')
			case 'u':
				r, ok := hex4(p.b[p.i:])
				if !ok {
					return "", p.errf("bad \\u escape")
				}
				p.i += 4
				if utf16.IsSurrogate(r) {
					if r >= 0xDC00 || p.i+6 > len(p.b) || p.b[p.i] != '\\' || p.b[p.i+1] != 'u' {
						return "", p.errf("lone surrogate")
					}
					r2, ok := hex4(p.b[p.i+2:])
					if !ok || r2 < 0xDC00 || r2 > 0xDFFF {
						return "", p.errf("lone surrogate")
					}
					p.i += 6
					r = utf16.DecodeRune(r, r2)
				}
				sb.WriteRune(r)
			default:
				return "", p.errf("bad escape")
			}
		default:
			r, n := utf8.DecodeRune(p.b[p.i:])
			if r == utf8.RuneError && n <= 1 {
				return "", p.errf("invalid UTF-8")
			}
			sb.Write(p.b[p.i : p.i+n])
			p.i += n
		}
	}
}

// Canonical returns the canonical JSON of v (SPEC section 4): object keys sorted by UTF-16 code
// units, no whitespace, strings escaped and numbers formatted exactly as ECMAScript's
// JSON.stringify does. This is RFC 8785 (JCS).
func Canonical(v any) (string, error) {
	var sb strings.Builder
	if err := canon(&sb, v); err != nil {
		return "", err
	}
	return sb.String(), nil
}

// MustCanonical is Canonical for values this package built itself.
func MustCanonical(v any) string {
	s, err := Canonical(v)
	if err != nil {
		panic(err)
	}
	return s
}

func lessUTF16(a, b string) bool {
	ua, ub := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

// SortedKeys returns m's keys in canonical (UTF-16 code unit) order.
func SortedKeys[V any](m map[string]V) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Slice(ks, func(i, j int) bool { return lessUTF16(ks[i], ks[j]) })
	return ks
}

func canon(sb *strings.Builder, v any) error {
	switch x := v.(type) {
	case nil:
		sb.WriteString("null")
	case bool:
		if x {
			sb.WriteString("true")
		} else {
			sb.WriteString("false")
		}
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			sb.WriteString("null") // what JSON.stringify does; never produced by ParseJSON
		} else {
			sb.WriteString(NumberString(x))
		}
	case int:
		sb.WriteString(NumberString(float64(x)))
	case int64:
		sb.WriteString(NumberString(float64(x)))
	case string:
		quote(sb, x)
	case []any:
		sb.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				sb.WriteByte(',')
			}
			if err := canon(sb, e); err != nil {
				return err
			}
		}
		sb.WriteByte(']')
	case []string:
		sb.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				sb.WriteByte(',')
			}
			quote(sb, e)
		}
		sb.WriteByte(']')
	case map[string]any:
		sb.WriteByte('{')
		for i, k := range SortedKeys(x) {
			if i > 0 {
				sb.WriteByte(',')
			}
			quote(sb, k)
			sb.WriteByte(':')
			if err := canon(sb, x[k]); err != nil {
				return err
			}
		}
		sb.WriteByte('}')
	case map[string]string:
		sb.WriteByte('{')
		for i, k := range SortedKeys(x) {
			if i > 0 {
				sb.WriteByte(',')
			}
			quote(sb, k)
			sb.WriteByte(':')
			quote(sb, x[k])
		}
		sb.WriteByte('}')
	default:
		return fmt.Errorf("canonical: unsupported type %T", v)
	}
	return nil
}

func quote(sb *strings.Builder, s string) {
	sb.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			sb.WriteString(`\"`)
		case '\\':
			sb.WriteString(`\\`)
		case '\b':
			sb.WriteString(`\b`)
		case '\f':
			sb.WriteString(`\f`)
		case '\n':
			sb.WriteString(`\n`)
		case '\r':
			sb.WriteString(`\r`)
		case '\t':
			sb.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(sb, `\u%04x`, r)
			} else {
				sb.WriteRune(r)
			}
		}
	}
	sb.WriteByte('"')
}

// NumberString formats a double the way ECMAScript's Number.prototype.toString does
// (shortest round-trip digits; exponent form below 1e-6 and from 1e21).
func NumberString(x float64) string {
	if x == 0 {
		return "0" // also -0
	}
	if math.IsNaN(x) {
		return "NaN"
	}
	if math.IsInf(x, 1) {
		return "Infinity"
	}
	if math.IsInf(x, -1) {
		return "-Infinity"
	}
	if x < 0 {
		return "-" + NumberString(-x)
	}
	e := strconv.FormatFloat(x, 'e', -1, 64) // d.ddde±XX
	mant, exp, _ := strings.Cut(e, "e")
	digits := strings.Replace(mant, ".", "", 1)
	ex, _ := strconv.Atoi(exp)
	k, n := len(digits), ex+1
	switch {
	case k <= n && n <= 21:
		return digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return "0." + strings.Repeat("0", -n) + digits
	}
	sign := "+"
	if n-1 < 0 {
		sign = "-"
	}
	ab := n - 1
	if ab < 0 {
		ab = -ab
	}
	if k == 1 {
		return digits + "e" + sign + strconv.Itoa(ab)
	}
	return digits[:1] + "." + digits[1:] + "e" + sign + strconv.Itoa(ab)
}

// UTF16Len is the length of s in UTF-16 code units: what the spec's "characters" means for key
// and value limits (SPEC section 11), matching the reference host.
func UTF16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// IsSafeInteger reports Number.isSafeInteger(v) for a decoded JSON value.
func IsSafeInteger(v any) bool {
	f, ok := v.(float64)
	return ok && f == math.Trunc(f) && math.Abs(f) <= 9007199254740991
}
