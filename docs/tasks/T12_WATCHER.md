# Running a T12 watcher

T12 is only as safe as its most attentive watcher: a forged batch finalizes if nobody disputes it within the
6-hour window. The project runs one watcher; the design asks for at least two machines, run by different
people where possible. Anyone can run one, with or without an account.

## What it does

Every 5 minutes, oldest pending batch first: fetch the real headers over the batch's range from source A
(Bitcoin P2P by default), cross-check the header at the claimed height with source B (mempool.space /
blockstream.info), replay them with the contract's rules and compare every claimed field. Code:
`indexer/zk-watcher.mjs`, decisions tested in `indexer/zk-challenge.test.mjs`.

| state | alert-only (no key) | acting (key + funds) |
|---|---|---|
| batch matches the chain | logs `matches the chain` | same; finalizes batches whose window has passed |
| batch does not match, window open | logs `does not match the chain: <fields>` | disputes (bond), then `refute`s at once |
| disputed, matches | logs | `back`s it with the headers and earns the bond |
| sources disagree | logs `sources disagree`, does nothing | same |

## Alert-only, with Docker (any machine)

```sh
git clone https://github.com/MM-sheng/wuji.git && cd wuji
docker compose --profile zk-watcher up -d zk-watcher
docker compose logs -f zk-watcher
```

No key, no funds; it never sends a transaction. The first time a batch is pending it syncs the whole Bitcoin
header chain over P2P (≈ 77 MB, ≈ 25 minutes; kept in the `zk-watch-data` volume) and logs
`Bitcoin tip timed out` once per round until that finishes. Point your alerting at the words
`does not match` and `MISMATCH PAST ITS WINDOW`. Override the RPC with `ZK_RPC=…` and the manifest with
`ZK_MANIFEST=…` (default `contracts/deployments/sepolia-zk-t12-v2.json`).

## Acting

Create a **new** Sepolia account in an encrypted Foundry keystore on that machine (never reuse the project's),
fund it with at least 0.05 ETH (one dispute bond) plus gas, and mount it like the keeper:

```yaml
# compose.watcher-key.yml
services:
  zk-watcher:
    environment:
      KEYSTORE_ACCOUNT: watcher-two
      PASSWORD_FILE: /run/secrets/watcher-password
    volumes:
      - {type: bind, source: /abs/path/keystore.json, target: /home/node/.foundry/keystores/watcher-two, read_only: true}
      - {type: bind, source: /abs/path/password, target: /run/secrets/watcher-password, read_only: true}
```

```sh
docker compose -f docker-compose.yml -f compose.watcher-key.yml --profile zk-watcher up -d zk-watcher
```

Bonds and backing rewards accrue in the contract; withdraw with `withdraw()` from that account.

## Without Docker

```sh
RPC=https://ethereum-sepolia-rpc.publicnode.com CHAIN_ID=11155111 \
ZK_INDEX=0x0350ff376F14bE43CbF62cC48E73D72dB86d1DC7 WATCH_SOURCES=p2p,http \
node indexer/zk-watcher.mjs            # add KEYSTORE_ACCOUNT=… PASSWORD_FILE=… to act
```

Node ≥ 18 and, to act, Foundry's `cast`. No other dependencies.

## Status

| machine | operator | mode | since |
|---|---|---|---|
| project Mac mini | project | acting (deployer account) | 2026-10-01 |
| — | — | — | wanted |
