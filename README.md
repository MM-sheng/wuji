# WUJI · 无极

> 无极生太极，太极生两仪。
> A market before reason. From nothing, yin and yang; together, always whole.

WUJI is an asset correlated with nothing. Its price is written by BNB Chain block hashes — no oracle, no governance, no admin, no reason. Every step is verifiable from any public RPC.

- `docs/ARCHITECTURE.md` — every decision that has been made, and why
- `indexer/` — follows BSC, computes the index, serves it (a cache, not an authority)
- `apps/terminal/` — the trading terminal (paper account today, wallet later)
- `contracts/` — price + vault contracts (next)

## Run

```bash
node indexer/index.mjs        # mainnet index → http://localhost:8787  (terminal + API)
./scripts/testnet.sh          # testnet index (:8788) + keeper for the deployed contracts (needs contracts/.env)
cd contracts && forge test    # unit / fuzz / invariant suites
```

Testnet deployment: `contracts/deployments/bsc-testnet.json`.

API: `/head` · `/seconds?from&to` · `/blocks?from&to` · `/blockAt?ts` · `/proof/:block`
