# Server and edge hosts: what was proven, and how

SPEC section 10 ("same layer, any host") is built and tested. The same signed manifest stream now runs on a server host that owns shared multi-user data, secrets and heavy compute, while clients keep swaps, shadow checks and rollback on the device.

- Server/edge host: `host/server-host.mjs`
- Client link (remote calls, shared cache, offline queue): `host/remote-client.mjs`
- Server layers: `layers/server/` (shared task list, payments, a deliberately bad layer); client layers: `layers/variants/tasks_shared*.ts`
- Proof: `npm run test:hosts` (30 checks over real WebSockets, layer workers, a local payment API, four users and two tenants)
- Measurements: `npm run bench:hosts` (raw numbers in `docs/hosts-results.json`)

## The open questions from SPEC section 11, answered by running them

| Question (SPEC v0) | Answer | Proof |
|---|---|---|
| Is "server commits first + overlap window" enough without a cross-host commit? | Yes, for every case we could construct. The server relays version N only after committing it (H12), so a new client op works right away (H14). A server refusal is never relayed and clients keep working (H22). Old clients are served by the old server layer inside the window (H15), get `version_mismatch` after it (H16), and an offline client that misses the window swaps and retries automatically (H17). The one case it doesn't cover: a client that can't run N fails with a clear error after the window, until the publisher ships N+1 (H20, H21). | H12 to H22 |
| How long must the window be? | Long enough to cover a client's swap time, which only affects latency: a client outside the window retries once. Measured with 40 clients: a server-only change reaches all of them in about 20 ms; a change that swaps the client layer, 350 ms p50 and 490 ms max. Default 30 s. | bench fan-out |
| Does shadow-copying a big multi-user store scale? | Not as built in v0: sending the whole state to the layer worker on every call cost 157 ms per event at 100k keys, and at 1M keys every call broke the 100 ms limit. Fixed in the core: a copy-on-write shadow for swaps, and a change log so each call carries only changed keys. A call now costs 0.1 to 0.2 ms at 3k, 300k and 1M keys. A swap with a migration over every task: 10 ms (3k keys), 680 ms (300k), 2.7 s (1M), within the server's default limits. | bench store size |
| Offline clients: do `shared/` writes queue or fail? How do conflicts resolve? | They queue (up to 5 minutes) and run exactly once, in order, on reconnect, including when the reply was lost after the server ran the call. Writes are operations the server layer applies to the authoritative state, so there are no overwrite conflicts. | H17, H18, H19 |
| Many tenants on one server node | Each tenant has its own store, workers, limits and queue. A tenant's infinite loop is killed at its limit while another tenant's calls stay under 2 ms (H23); the layer comes back (H24); tenants can't see each other's data (H25). A worker costs about 9 MB, so idle tenants' workers are stopped and restarted on the next call in about 35 ms (H30). A tenant with too many queued calls gets `overloaded` (H27). | H23 to H27, H30 |
| `remote` wire format, auth, error model | Specified in SPEC 10.2 and implemented. The caller is always the authenticated user (H6); bad, wrong-app and expired tokens are refused (H8); server layers validate untrusted input (H7). | H6 to H8 |
| Secrets and payments | The payment API key lives only in the server's `charge` capability provider. The test scans every byte sent to or from clients, every layer and the whole server store: the key is never there (H11). | H10, H11 |
| Key custody for the authority | The server host holds only public keys (H2), and a compromised relay can't push code because clients check the signature (H28). Release/root key rotation is SPEC 12.4. HSM custody is still unspecified. | H2, H28 |

## Measurements (Node 22, Linux container)

Store size (one tenant, shared task list, 50 calls each):

| Shared keys | Call p50 | Call p99 | First call (worker gets a full copy once) | Swap + migration of every task | Client connect, mirroring all | Client connect, `watch` one key |
|---|---|---|---|---|---|---|
| 3,002 | 0.12 ms | 0.85 ms | 3 ms | 10 ms | 92 ms | 63 ms |
| 300,002 | 0.11 ms | 21 ms | 308 ms | 677 ms | 1.1 s | 164 ms |
| 1,000,001 | 0.15 ms | 42 ms | 1.0 s | 2.7 s | fails: client worker out of memory | 343 ms |

Before the change-log fix, an event at 100k keys took 157 ms, and at 1M keys the swap was refused because the health check ran past its 100 ms limit.

Fan-out to 40 clients: server-only change 13 to 24 ms to reach every client; client layer change 354 ms p50, 487 ms max.

Throughput: 4,000 to 7,000 calls per second for one tenant (calls are serialized per tenant).

Tenants: 50 tenants with 2 server layers each add about 900 MB RSS (about 9 MB per worker). After stopping idle workers, RSS fell to about 500 MB; the next call restarts a worker in about 35 ms.

## What is still open

See SPEC section 11 ("Run-anywhere hosts, what's still open"). In short: the server doesn't yet keep every fleet channel's version live at once; calls per tenant are serialized; there's no per-user read control on `shared/`; and one tenant lives in one server process (no replication or durable storage yet).
