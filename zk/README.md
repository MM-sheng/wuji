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
