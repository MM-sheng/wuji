# WUJI · 无极

> 无极生太极，太极生两仪。
> A market about nothing. Verifiable. Heartbeat: Bitcoin.

WUJI is a verifiable pure-randomness settlement market and public benchmark. Its settlement index is
derived from Bitcoin proof-of-work headers and can be independently recomputed. “Pure randomness” describes
the intended model; it is not a proof of unbiased mining, independence from every asset, or investment returns.
There is no owner, governance or upgrade key. Paired YANG/YIN vaults are one application of this public index.

Four different things must be distinguished:

| Object | Meaning |
|---|---|
| Index `S` | An integer-derived cumulative path; `100·exp(S)` is its display level, not a traded token price. |
| Instantaneous settlement share `g` | `clamp(½ + ½·(S−S₀), 0, 1)`, an absolute-position allocation for the current series. |
| Payoff at expiry | `N·g(S_T)` for YANG and its complement for YIN at the predetermined Bitcoin height, before redemption fees and rounding. |
| Market price | The executable price offered by buyers/sellers; the terminal does not supply a live market price for these claims. |

The share is **not a price and must never be used as a lending-collateral price feed**. Before expiry, it
does not grant single-sided redemption at that amount. Different chains, collateral, notionals and series
create a family of separate claims sharing a settlement index; they are not interchangeable tokens.
Solvency in collateral units assumes ordinary ERC-20 behaviour. An arbitrary-token vault created by the
permissionless factory carries no equal-safety promise. Collateral price and issuer risks remain.

- `docs/ARCHITECTURE.md` — every decision that has been made, and why
- `indexer/` — follows Bitcoin headers; retains the old BSC source as a comparison mode (a cache, not an authority)
- `apps/terminal/` — index display, paper simulation and testnet wallet
- `contracts/` — deployed testnet index + paired YANG/YIN vault
- `docs/THREAT_MODEL.md` — trust boundaries, attack paths, and mainnet blockers
- `docs/AUDIT_NOTES.md` — internal findings and remediation status
- `docs/MAINNET_CHECKLIST.md` — required evidence before a production deployment

## Run

```bash
node indexer/index.mjs                    # legacy BSC index → http://localhost:8787
# Bitcoin testnet startup and deployment instructions are below.
cd contracts && ~/.foundry/bin/forge test # unit / fuzz / invariant suites
```

Testnet deployment: `contracts/deployments/bsc-testnet.json`.

API: `/head` · `/seconds?from&to` · `/blocks?from&to` · `/blockAt?ts` · `/proof/:block`

The terminal includes paper trading plus the testnet **两仪 · On-chain** view: contract/index
cross-checks, series solvency, wallet balances, paired minting, and paired redemption.

## Production status

Testnet prototype only. Fixed Bitcoin-height checkpoint settlement removes the known caller timing option.
One series spans 4320 Bitcoin heights (about 30 days on average, not a fixed calendar deadline).
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

### Existing reward testnet — comparison version, economics superseded

The latest `contracts/deployments/bsc-testnet.json` uses an immutable fee router: 50% to
relayer/folder lifetime points and 50% to the DEAD address. The previous Bitcoin deployment is
preserved in `contracts/deployments/bsc-testnet-bitcoin-v1.json` for the original series observation.
Run alongside the old terminal without sharing its cache:

```bash
PORT=8790 PROCESS_PREFIX=wuji-rewards DATA_DIR="$PWD/indexer/data/rewards" bash scripts/bitcoin-testnet.sh
VERIFICATION_OUTPUT=contracts/deployments/rewards-verification.json node scripts/verify-bitcoin-deployment.mjs
```

The keeper routes ordinary ERC-20 vault fees automatically when a router balance is at least two
smallest units. Workers call `RelayerRewards.claim(token)` to withdraw; a long unclaimed work history
may require repeated calls (128 new point lots per default call). Rewards are not guaranteed gas reimbursement.
See [T1 review](docs/tasks/T1_REPORT.md) for this deployed version's accounting and finality rules.

The [current plan](docs/tasks/NEXT.md) replaces burning and lifetime points with a 100% operations reserve
and one-off bounties per finalized height. That rework is **not implemented or deployed** yet. The additional
[T2 deployment](contracts/deployments/t2-interrupted-deployment.json) was confirmed on testnet but left unused
after this decision; the active manifest and port 8790 still refer to the existing comparison version.
