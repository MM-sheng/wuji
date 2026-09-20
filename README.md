# WUJI · 无极

> 无极生太极，太极生两仪。
> A market before reason. From nothing, yin and yang; together, always whole.

WUJI is an asset correlated with nothing. Its price is written by BNB Chain block hashes — no oracle, no governance, no admin, no reason. Every step is verifiable from any public RPC.

- `docs/ARCHITECTURE.md` — every decision that has been made, and why
- `indexer/` — follows BSC, computes the index, serves it (a cache, not an authority)
- `apps/terminal/` — the trading terminal (paper account today, wallet later)
- `contracts/` — deployed testnet index + paired YANG/YIN vault
- `docs/THREAT_MODEL.md` — trust boundaries, attack paths, and mainnet blockers
- `docs/AUDIT_NOTES.md` — internal findings and remediation status
- `docs/MAINNET_CHECKLIST.md` — required evidence before a production deployment

## Run

```bash
node indexer/index.mjs                    # mainnet index → http://localhost:8787
./scripts/testnet.sh                      # testnet index (:8788) + keeper
cd contracts && ~/.foundry/bin/forge test # unit / fuzz / invariant suites
```

Testnet deployment: `contracts/deployments/bsc-testnet.json`.

API: `/head` · `/seconds?from&to` · `/blocks?from&to` · `/blockAt?ts` · `/proof/:block`

The terminal includes paper trading plus the testnet **两仪 · On-chain** view: contract/index
cross-checks, series solvency, wallet balances, paired minting, and paired redemption.

## Production status

Testnet prototype only. Fixed-block checkpoint settlement removes the known caller timing option.
Do not deploy to mainnet until an independent contract review and the remaining checklist are complete.

## Bitcoin source (2026-09-20)

The Bitcoin implementation is isolated from the legacy BSC comparison stack. Read
[the architecture](docs/ARCHITECTURE.md) and [acceptance report](docs/BTC_SOURCE_REPORT.md).

```
node --test indexer/bitcoin.test.mjs indexer/bitcoin-index.test.mjs
cd contracts && forge test
```

Prepare a fresh independently compared checkpoint with `node scripts/prepare-bitcoin-checkpoint.mjs`.
Deploy with `ENV_FILE=/absolute/path/to/contracts/.env bash contracts/scripts/deploy-testnet.sh` after tests.
Start the new stack with the same ENV_FILE and `bash scripts/bitcoin-testnet.sh` (port 8789).
The env contains only the Foundry account name, password-file path, deployer and RPC; never add a private key.

For a local Bitcoin source: set `BITCOIN_API=http://127.0.0.1:8332` and
`BITCOIN_API_KIND=bitcoind-rest` (Core REST enabled), or point BITCOIN_API at a local Esplora API.
`SOURCE=bitcoin GENESIS_HEIGHT=... PORT=8789 node indexer/index.mjs` also runs standalone without contracts.
It stays at 100 until the genesis height has six descendants. Averages are not block countdown guarantees.

The old BSC deployments are archived in `contracts/deployments/bsc-testnet-legacy.json`.
On the Bitcoin branch, use `scripts/bitcoin-testnet.sh`; do not run the old BSC startup script against the new manifest.
