// "Stats" footer layer — written in C. Shares state with the Tasks layer through the host.
#include "../../sdk/c/llp.h"

static char kbuf[64], nbuf[16], sbuf[256];

static int done_count(int n) {
  int d = 0;
  for (int i = 0; i < n; i++) {
    kbuf[0] = 0; cat(kbuf, "tasks."); cat(kbuf, itoa(i, nbuf)); cat(kbuf, ".done");
    if (get_num(kbuf, 0) > 0) d++;
  }
  return d;
}

EXPORT("llp_schema") int llp_schema(void) { return 1; }

EXPORT("llp_view") void llp_view(void) {
  int n = (int)get_num("tasks.n", 0);
  int d = done_count(n);
  int pct = n ? (d * 100) / n : 0;
  el("card");
    el("row");
      el("label"); text("Progress (C layer)"); end();
      el("big"); sbuf[0] = 0; cat(sbuf, itoa(pct, nbuf)); cat(sbuf, "%"); text(sbuf); end();
    end();
    el("progress"); attr("value", itoa(pct, nbuf)); end();
    el("row");
      button("where", "Where am I?");
      button("buzz", "Buzz");
    end();
    if (get_str("geo", sbuf, sizeof sbuf) > 0) { el("label"); text(sbuf); end(); }
  end();
}

EXPORT("llp_event") void llp_event(void) {
  char id[64]; int n = _ev_id(id, 63); if (n > 63) n = 63; id[n] = 0;
  if (llp_eq(id, n, "where")) { set_str("geo", "Locating…"); cap_call("geo", ""); }
  else if (llp_eq(id, n, "buzz")) { cap_call("haptic", "80"); }
  else if (llp_eq(id, n, "cap:geo")) {
    char v[200]; int m = _ev_val(v, 199); if (m > 199) m = 199; v[m] = 0;
    set_str("geo", v);
  }
}
