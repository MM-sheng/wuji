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

Testnet prototype only. Do not deploy the present vault to mainnet until the settlement-time
optionality described in `docs/THREAT_MODEL.md` is removed and an independent contract review is complete.
