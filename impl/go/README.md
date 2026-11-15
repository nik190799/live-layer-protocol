# LLP host in Go

An independent Live Layer Protocol host, written from `../../SPEC.md`. It shares no code with the JavaScript reference host and uses [wazero](https://wazero.io) (pure Go, no cgo) to run layers.

| Package | What it is |
|---|---|
| `llp/json.go` | Strict JSON parser and canonical JSON (RFC 8785) |
| `llp/crypto.go` | SHA-256 content addresses, P-256 JWK keys, `r‖s` signatures |
| `llp/layer.go` | The layer ABI (modules `llp` and `env`), UI trees, time and memory limits |
| `llp/host.go` | The client host: manifest rules, shadow staging, migrations, commit, render, events, capabilities, revert |
| `llp/fleet.go` | Rollout buckets, keyrings, the fleet agent (challenge hello, channels, shares, freshness, status) |
| `cmd/llp-host` | Headless host: follows a publisher (SPEC 5) or a fleet controller (SPEC 12); one JSON object per output line |
| `cmd/llp-conformance` | Runs `../../conformance/vectors` against this host |

```
go run ./cmd/llp-conformance ../../conformance     # 158 checks
go build -o llp-host ./cmd/llp-host
```

Not implemented: the server/edge role (SPEC section 10) and the device service (10.4).
