# WUJI

Read `docs/ARCHITECTURE.md` before changing anything about the index, the pair (YANG/YIN), series, or the vault. It is the source of truth for decisions; update it when a decision changes.

- Zero dependencies so far (Node ≥ 18, plain HTML). Keep it that way until contracts need tooling.
- `indexer/data/` is generated; never commit it. Genesis block is `122616000`; changing it invalidates the data file.
- The indexer is a cache. Anything it serves must be recomputable from a public RPC (`/proof/:block` shows how).
- Terminal talks to the indexer at the same origin (or `localhost:8787` when opened as a file).
