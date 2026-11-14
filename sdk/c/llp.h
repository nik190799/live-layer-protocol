// Live Layer Protocol (LLP) v0 — C SDK (no libc needed)
#ifndef LLP_H
#define LLP_H
#define IMPORT(name) __attribute__((import_module("llp"), import_name(name)))
#define EXPORT(name) __attribute__((export_name(name)))

IMPORT("ui_begin") void _ui_begin(const char*, int);
IMPORT("ui_attr")  void _ui_attr(const char*, int, const char*, int);
IMPORT("ui_text")  void _ui_text(const char*, int);
IMPORT("ui_end")   void _ui_end(void);
IMPORT("kv_get_n") double _kv_get_n(const char*, int, double);
IMPORT("kv_set_n") void _kv_set_n(const char*, int, double);
IMPORT("kv_get_s") int _kv_get_s(const char*, int, char*, int);
IMPORT("kv_set_s") void _kv_set_s(const char*, int, const char*, int);
IMPORT("ev_id")    int _ev_id(char*, int);
IMPORT("ev_val")   int _ev_val(char*, int);
IMPORT("cap")      int _cap(const char*, int, const char*, int);
IMPORT("log")      void _log(const char*, int);

static int llp_len(const char* s) { int n = 0; while (s[n]) n++; return n; }
static int llp_eq(const char* a, int an, const char* b) { int bn = llp_len(b); if (an != bn) return 0; for (int i = 0; i < an; i++) if (a[i] != b[i]) return 0; return 1; }

static void el(const char* k) { _ui_begin(k, llp_len(k)); }
static void attr(const char* k, const char* v) { _ui_attr(k, llp_len(k), v, llp_len(v)); }
static void text(const char* s) { _ui_text(s, llp_len(s)); }
static void end(void) { _ui_end(); }
static void button(const char* id, const char* caption) { el("button"); attr("id", id); text(caption); end(); }
static double get_num(const char* k, double d) { return _kv_get_n(k, llp_len(k), d); }
static void set_num(const char* k, double v) { _kv_set_n(k, llp_len(k), v); }
static int get_str(const char* k, char* buf, int cap) { int n = _kv_get_s(k, llp_len(k), buf, cap - 1); if (n > cap - 1) n = cap - 1; buf[n] = 0; return n; }
static void set_str(const char* k, const char* v) { _kv_set_s(k, llp_len(k), v, llp_len(v)); }
static int cap_call(const char* name, const char* arg) { return _cap(name, llp_len(name), arg, llp_len(arg)); }

// tiny integer -> string (returns pointer into buf)
static char* itoa(int v, char* buf) {
  char tmp[16]; int i = 0, neg = v < 0; unsigned u = neg ? -v : v;
  do { tmp[i++] = '0' + (u % 10); u /= 10; } while (u);
  int j = 0; if (neg) buf[j++] = '-';
  while (i) buf[j++] = tmp[--i];
  buf[j] = 0; return buf;
}
static char* cat(char* dst, const char* src) { char* d = dst; while (*d) d++; while (*src) *d++ = *src++; *d = 0; return dst; }
#endif
