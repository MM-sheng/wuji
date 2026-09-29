# zk — proving the index instead of replaying it

| crate | what it is |
|---|---|
| `wuji-header-core` | Bitcoin header rules + the WUJI index accumulator. No zkVM dependency, unit-tested against real mainnet headers. The single source of truth for the guest. |
| `program` | SP1 guest: reads a batch, calls `verify_batch`, commits the journal `ZkWujiIndex.Journal` expects. |
| `script` | Host: `execute` (no proof, prints cycles), `prove` (Groth16, prints vkey/journal/proof), `journal --out` (writes the ABI-encoded journal for the Solidity interop test). |

```bash
cargo test --release --manifest-path zk/wuji-header-core/Cargo.toml   # rules vs. real headers
cd zk/script && cargo run --release -- execute --headers 100          # run the guest
cd zk/script && cargo run --release -- prove   --headers 100          # real proof + timing
```

Building the guest needs the SP1 toolchain (`curl -L https://sp1up.succinct.xyz | bash && sp1up`).
Nothing else in this repository depends on it: `ZkWujiIndex.foldHeaders` validates raw headers in
Solidity, so the protocol keeps running whether or not a prover exists.

See `docs/tasks/T10_DESIGN.md` for why the guest proves the index increment rather than only the chain,
and why continuity is carried from `tip − CONFIRMATIONS`.

## Groth16 (on-chain format) — 2026-09-29

- Needs Go (`brew install go`); the host enables SP1's `native-gnark` feature so the Groth16 step runs
  natively on Apple silicon instead of in SP1's amd64-only Docker image.
- Needs SP1's circuit artifacts v6.1.0 (6.2 GB download, 7.9 GB extracted) in `~/.sp1/circuits/groth16/v6.1.0`
  with an empty `.complete` marker. SP1's own installer deletes a partial download on any interruption; a
  resumable `curl -C -` of `https://sp1-circuits.s3-us-east-2.amazonaws.com/v6.1.0-groth16.tar.gz`, then
  `tar -xzf` into that directory, works on slow links.
- `cargo run --release -- --headers 100 prove --mode groth16` prints the proof and journal; they are the
  fixtures `contracts/test/fixtures/zk-groth16-100.{proof,journal}.hex` used by `ZkWujiGroth16.t.sol`.
- Measured: 217 s, 31 GB peak memory, 14-core M-series.
