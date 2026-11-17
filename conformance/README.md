# Conformance suite

`vectors/` holds the test vectors every LLP host must pass. `run-js.mjs` runs them against the
JavaScript host. The Go host in `impl/go` runs the same vectors.

**`keys.json` holds throwaway test keys, private halves included, on purpose.** The vectors are
signed with them so that any implementation can check its signature handling against known
answers. They are not used anywhere else. Never trust them in a real host. `gen.mjs` regenerates
the keys and vectors.
