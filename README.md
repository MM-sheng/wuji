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

Current timestamp-checking testnet manifest: `contracts/deployments/bsc-testnet-timestamps-v3.json` (port 8792).
Sepolia/WETH manifest: `contracts/deployments/sepolia-weth-v3.json` (port 8793).
Live verification and receipts: [T3 report](docs/tasks/T3_REPORT.md).
The earlier reserve manifest remains `contracts/deployments/bsc-testnet-reserve-v2.json` (port 8791).
`bsc-testnet.json` is retained as the historical lifetime-points comparison manifest.

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
node --test indexer/bitcoin.test.mjs indexer/bitcoin-index.test.mjs indexer/bitcoin-time.test.mjs indexer/bitcoin-keeper.test.mjs
cd contracts && forge test
```

Prepare a fresh independently compared checkpoint with `node scripts/prepare-bitcoin-checkpoint.mjs`.
Deploy with `ENV_FILE=/absolute/path/to/contracts/.env bash contracts/scripts/deploy-testnet.sh` after tests.
Use the explicit manifest/port command below to start the timestamp-checking stack (port 8792).
The env contains only the Foundry account name, password-file path, deployer and RPC; never add a private key.
Deployment requires exclusive use of the deployer's transaction nonce: pause keepers sharing that account,
wait for in-flight transactions to confirm, and resume them afterwards. The deploy script rejects known active
local comparison keepers before reading credentials; it cannot detect signers on other machines.

For a local Bitcoin source: set `BITCOIN_API=http://127.0.0.1:8332` and
`BITCOIN_API_KIND=bitcoind-rest` (Core REST enabled), or point BITCOIN_API at a local Esplora API.
`SOURCE=bitcoin GENESIS_HEIGHT=... PORT=8789 node indexer/index.mjs` also runs standalone without contracts.
It stays at 100 until the genesis height has six descendants. Averages are not block countdown guarantees.

The old BSC deployments are archived in `contracts/deployments/bsc-testnet-legacy.json`.
On the Bitcoin branch, use `scripts/bitcoin-testnet.sh`; do not run the old BSC startup script against the new manifest.

### Timestamp-checking testnet — current implementation

MTP uses each parent branch's eleven-header window, authenticated back to the existing checkpoint. Headers
must be no more than two hours ahead of the host chain clock and obey mainnet minimum-version rules.
With pending heights, folds require the best tip's advertised time to be at most three hours old. This bounds
age; it does not prove the relay is globally caught up. Standalone relaying remains available while stale,
and folding resumes when the best tip meets the rule. The terminal displays this gate alongside reconciliation.

```bash
MANIFEST=contracts/deployments/bsc-testnet-timestamps-v3.json PORT=8792 PROCESS_PREFIX=wuji-timestamps DATA_DIR="$PWD/indexer/data/timestamps-v3" bash scripts/bitcoin-testnet.sh
MANIFEST=contracts/deployments/bsc-testnet-timestamps-v3.json VERIFICATION_OUTPUT=contracts/deployments/timestamps-verification.json node scripts/verify-bitcoin-deployment.mjs
LOG_RPC=https://bsc-testnet-rpc.publicnode.com MANIFEST=contracts/deployments/bsc-testnet-timestamps-v3.json INDEXER_URL=http://localhost:8792 OPERATION_OUTPUT=contracts/deployments/timestamps-operation.json node scripts/verify-reserve-operation.mjs
```

`LOG_RPC` selects an event-capable read provider when the deployment RPC rejects `eth_getLogs`. The replay
checks that both providers agree on the observation block hash before combining logs and contract state.

The v3 manifest enables `RELAY_TIMESTAMPS=1` for the keeper and indexer automatically. When launching those
processes directly, set it explicitly. The BSC testnet v3 startup sets `KEEPER_GAS_PRICE=0.1gwei` and uses
legacy transactions because some testnet RPC fee estimators suggest a tip below the node minimum. Override
that environment value for operator policy, or set it empty to restore automatic fee selection. This is
a keeper setting, not a protocol constant or a gas-price oracle. Keeper simulation uses the actual worker address; an old bootstrap
that cannot yet pass the fold gate progresses through standalone header submissions.
See [T2b report](docs/tasks/T2B_REPORT.md) for Core provenance, limitations, validation and live evidence.

The existing testnet genesis remains 967826. `scripts/extend-checkpoint-history.mjs` authenticates the eleven
ancestors to the already recorded checkpoint instead of choosing another genesis. A fresh deployment
checkpoint can be prepared with `scripts/prepare-bitcoin-checkpoint.mjs`; set `GENESIS_HEIGHT` to preserve an
existing path. Neither procedure establishes full-node validity from scratch.

### Operations reserve — also retained at port 8791

The immutable router sends 100% of each vault's fees into the operations reserve. Each newly folded Bitcoin
height allocates floor(available reserve / 10000) per selected token, sequentially across a batch. The folder
can claim that fixed amount; past work never gains a share of later fees or donations. There is no burn or
lifetime-points scheme in this deployment. Funded mock balances have no economic value.

```bash
MANIFEST=contracts/deployments/bsc-testnet-reserve-v2.json PORT=8791 PROCESS_PREFIX=wuji-reserve DATA_DIR="$PWD/indexer/data/reserve-v2" bash scripts/bitcoin-testnet.sh
MANIFEST=contracts/deployments/bsc-testnet-reserve-v2.json VERIFICATION_OUTPUT=contracts/deployments/reserve-verification.json node scripts/verify-bitcoin-deployment.mjs
node scripts/verify-reserve-operation.mjs
```

Reserve manifests enable atomic submit/fold and the listed `rewardTokens`. `REWARD_TOKENS` may select up to eight
assets; fees are collected and fixed bounties claimed every 144 folded heights by default. Override the cadence
with `ROUTE_EVERY_HEIGHTS` / `CLAIM_EVERY_HEIGHTS`. These are keeper preferences; permissionless contract calls
remain available. Plain folds or omitted assets forgo their bounty, and no reward covers gas by guarantee.

See [T1 reserve report](docs/tasks/T1_RESERVE_REPORT.md) for 92 Solidity tests, four Node tests, deployed bytecode
checks, mock mint/redeem/route receipts and live bounty evidence. T2b header checks are delivered separately above. Independent review and T9
frozen-state exits remain pending. Direct native-ETH vaults (T3 uses WETH), CREATE2 genesis and the ZK relay are later work.

### Earlier reward testnet — comparison version, economics superseded

The historical `contracts/deployments/bsc-testnet-rewards-v1.json` uses an immutable fee router: 50% to
relayer/folder lifetime points and 50% to the DEAD address. The previous Bitcoin deployment is
preserved in `contracts/deployments/bsc-testnet-bitcoin-v1.json` for the original series observation.
Run alongside the old terminal without sharing its cache:

```bash
MANIFEST=contracts/deployments/bsc-testnet-rewards-v1.json PORT=8790 PROCESS_PREFIX=wuji-rewards DATA_DIR="$PWD/indexer/data/rewards" bash scripts/bitcoin-testnet.sh
```

The keeper routes ordinary ERC-20 vault fees automatically when a router balance is at least two
smallest units. Workers call `RelayerRewards.claim(token)` to withdraw; a long unclaimed work history
may require repeated calls (128 new point lots per default call). Rewards are not guaranteed gas reimbursement.
See [T1 review](docs/tasks/T1_REPORT.md) for this deployed version's accounting and finality rules.

### Sepolia / WETH (T3)

The same Bitcoin checkpoint and genesis are reused on Sepolia, chain 11155111. The example vault uses
the [Sepolia WETH address listed by Uniswap](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments)
with 0.001 WETH per pair. This is a separate collateral claim sharing an index with the BSC deployment.

Use a separate encrypted Foundry account. `contracts/.env.sepolia` contains only `KEYSTORE_ACCOUNT`,
`PASSWORD_FILE`, `DEPLOYER` and `RPC`. Keep it and the password file local, mode 600; never paste a key
into a command or a log. The deployment wrapper simulates by default; `--broadcast` submits to Sepolia only.

```bash
node --test indexer/bitcoin*.test.mjs indexer/networks.test.mjs indexer/evm-rpc.test.mjs scripts/compare-chains.test.mjs apps/terminal/wallet.test.mjs
bash contracts/scripts/deploy-sepolia.sh
bash contracts/scripts/deploy-sepolia.sh --broadcast
# After successful broadcast, set DEPLOYMENT_COMMIT to the full reviewed source commit:
DEPLOYMENT_COMMIT=<full-commit> node scripts/record-sepolia-deployment.mjs
MANIFEST=contracts/deployments/sepolia-weth-v3.json VERIFICATION_OUTPUT=contracts/deployments/sepolia-verification.json node scripts/verify-bitcoin-deployment.mjs
ENV_FILE="$PWD/contracts/.env.sepolia" MANIFEST=contracts/deployments/sepolia-weth-v3.json bash scripts/bitcoin-testnet.sh
node scripts/compare-chains.mjs
READ_RPC=https://ethereum-sepolia.publicnode.com MANIFEST=contracts/deployments/sepolia-weth-v3.json INDEXER_URL=http://localhost:8793 OPERATION_OUTPUT=contracts/deployments/sepolia-operation.json node scripts/verify-reserve-operation.mjs
```

The Sepolia terminal defaults to port 8793, a separate cache and `wuji-sepolia` process names. Its keeper uses
automatic Ethereum fee selection, not the BSC-specific legacy gas override. Before starting the keeper,
`scripts/sepolia-smoke.mjs` can wrap 0.003 test ETH, donate 0.001 WETH to the operations reserve, mint and
redeem one pair, then route its fees. Source the local Sepolia env first; the script records receipts and
refuses to overwrite an existing smoke run. Donations are ordinary public funding, not a privilege.

The comparison pins reads to an EVM block on each chain, rejects differing parameters or a frozen folded
hash, and compares exact integer S and Bitcoin hash at the lower folded height. A faster chain is reversed
to that height by subtracting its extra canonical header increments (at most 4320). Empty indexes report
WAIT rather than PASS. This checks agreement under those RPC responses; T4 adds independent two-source
Bitcoin reconstruction. ETH gas is spent and WETH remains collateral; testnet bounties do not establish
economic sustainability.

`READ_RPC` optionally selects another historical-state endpoint for the operations replay. It must return
the expected chain ID and the same observation-block hash as the manifest RPC; `LOG_RPC` can independently
select a log endpoint subject to the same checks. Transport timeouts/HTTP 429/5xx on public reads have a
bounded retry budget; JSON-RPC execution errors fail immediately and writes are not automatically retried.

Historical bytecode verification must use that release's build artifacts, not the current reserve build.
The additional [T2 deployment](contracts/deployments/t2-interrupted-deployment.json) was confirmed on testnet
but left unused after the economic redesign. The first reserve deployment attempt was interrupted by a shared
wallet nonce and is archived in `reserve-interrupted-deployment.json`; the confirmed reserve-v2 manifest
identifies that T1 release. The timestamp-checking v3 release uses its own manifest and fresh immutable addresses.

## Verify the index yourself

From a reviewed checkout, with **Node 18+ only** (no npm install, indexer, wallet or signing):

```bash
node scripts/wuji-verify.mjs contracts/deployments/sepolia-weth-v3.json
# Or the same index on BSC testnet:
node scripts/wuji-verify.mjs contracts/deployments/bsc-testnet-timestamps-v3.json
```

The verifier pins all contract reads to one EVM block, independently implements the raw-digest hash formula,
compares raw headers from two Esplora sources, follows their linkage from the relay anchor and checks the six
linked descendants of `lastHeight`. It recomputes integer U/S and checks **both `checkpointed` and `checkpointS`**
at every due boundary, printing `PASS` or `FAIL` for each. It rechecks source/EVM views before a final PASS.
An empty index prints WAIT (exit 2); any mismatch, missing checkpoint or unavailable source exits 1.
Before height 972145 these deployments have no due checkpoints: an empty checkpoint list is not evidence of settlement.

Defaults are mempool.space and Blockstream. `READ_RPC` selects your settlement RPC;
`VERIFY_BITCOIN_SOURCES=url1,url2` selects two Esplora base URLs. Choose separate operators, ideally including
your own full-node-backed instance: different hostnames alone cannot prove operator independence.
`VERIFY_OUTPUT=/path/result.json` saves the result, including failure. Sources are never silently substituted.
Public API quotas can stop a run; retries are bounded and honor Retry-After. Blockstream requests are spaced at
least six seconds apart to respect its advertised hourly cap, so a long replay can take hours. An HTTP 429 is
an incomplete verification, not an index mismatch and not a PASS. A self-hosted source avoids shared public quotas.

This verifies arithmetic/header agreement under the selected RPC/source responses and trusted relay anchor.
It does not reimplement Bitcoin consensus or prove global synchronization, miner unbiasedness, economic returns
or contract safety. See [T4 report](docs/tasks/T4_REPORT.md) for the successful offline cases and live limitations.

## Run your own indexer / keeper in five minutes

Requires Docker with Compose. From this checkout (initialize its submodules for contract builds):

```bash
cp .env.docker.example .env.docker
# Edit public RPC / manifest / port preferences if needed.
docker compose --env-file .env.docker up -d --build indexer
docker compose --env-file .env.docker logs -f indexer
```

Open **http://localhost:8794**. The default is the Sepolia/WETH v3 deployment; choose
`contracts/deployments/bsc-testnet-timestamps-v3.json` and the matching RPC for BSC testnet.
The named data volume survives restarts. “Five minutes” covers startup, not a guaranteed history-sync time.
HTTP health only indicates that the server responds: check `/head` for `err`, `behind` and `chain.reconciliation`.
The container uses Node and Foundry images pinned by digest, runs as uid 1000, and has a read-only root filesystem.
For a custom manifest, mount its public JSON file and set `MANIFEST` to its path inside the container.

To relay/fold as an independent operator, first prepare and fund **your own encrypted testnet account**.
Set `KEYSTORE_ACCOUNT`, `KEYSTORE_FILE` and `PASSWORD_FILE` in `.env.docker` to its name and absolute host paths.
Only paths go in this file; never a private key or password. The example deliberately ships no signing credentials.
Do not share the deployer's wallet or run two keepers with the same account: their transaction nonces can conflict.
On Linux the container's uid 1000 needs read access to the two files; use ownership or a narrowly scoped ACL,
not world-readable password permissions. The bind mounts are read-only and missing files fail startup.

```bash
docker compose --env-file .env.docker --profile keeper up -d keeper
docker compose --env-file .env.docker logs -f keeper
# Stop your own stack; omit --volumes to retain the index cache.
docker compose --env-file .env.docker --profile keeper down
```

Without the explicit `keeper` service/profile, Compose starts only the indexer. Signing is through encrypted
Foundry keystores and the chain guard still runs before transactions. BSC defaults to 0.1 gwei legacy fees;
Sepolia uses automatic fee selection. These examples accept the two current testnet manifests only. Keeper
transactions spend test gas; reserve rewards do not guarantee reimbursement. See [Docker's profile semantics](https://docs.docker.com/compose/how-tos/profiles/).

## Reproduce deployed bytecode

With Foundry **1.8.3**, Node 18+, and the pinned submodules:

```bash
git submodule update --init --recursive
bash scripts/verify-bytecode.sh contracts/deployments/sepolia-weth-v3.json
# CI-equivalent offline integration checks:
node scripts/test-bytecode.mjs
docker build -t wuji-node:local .
node scripts/test-container.mjs
```

`verify-bytecode.sh` creates fresh build/cache directories and compiles solc **0.8.28**, optimizer 200,
Prague, via-IR off and IPFS/CBOR metadata on. Foundry expands scoped remappings with the checkout path;
that path was embedded in v3 metadata. `build-reproducible.mjs` therefore recompiles the fresh Standard JSON
with the release's literal `contracts/remappings-v3.json` contexts. It normalizes compiler **input**, then compares
unaltered compiler output including metadata. The historical path in that file is a metadata string; no directory
at that path is required. The CI test builds in two different directories to enforce this property.

Only compiler-declared immutable slots are masked. **Immutable values and constructor bindings are a separate
check**, implemented by `scripts/verify-bitcoin-deployment.mjs`; equality of masked code is not a security audit.
`READ_RPC` overrides the read endpoint and `BYTECODE_OUTPUT` saves the result. `SOLC` may select a native compiler
path; its exact version is checked. These scripts target the current v3 source; old releases require their own checkout.
The workflow runs all existing financial tests plus independent-verifier, real local deployment and container checks.

## Terminal heartbeat, source selection and IPFS

The Bitcoin terminal now has **Steps**, a block-height/hash heartbeat, a labelled statistical arrival estimate
and per-series heights remaining. In **数据源 · 核验**, save/select indexer URLs and choose an independent RPC.
The browser reads exact `S` and `yangShare` at a pinned EVM block, checks deployment bindings and clears stale
agreement badges. An RPC-only read still works when the indexer is unavailable; it is not header reconstruction.

With an initialized Kubo repository, run `bash scripts/publish-ipfs.sh`. It pins only the standalone `index.html`,
reads it back to check the bytes, and prints its directory CID. A local pin is not permanent public hosting.
See [terminal / IPFS operations](docs/TERMINAL_IPFS.md) for CORS, HTTPS, provider trust, pin replication and the
future `wuji.market` DNSLink setup. Delivery evidence: [T5 report](docs/tasks/T5_REPORT.md).
