# WUJI contracts

Three immutable contracts implement the testnet protocol:

- `WujiIndex` folds BSC block hashes into the integer log index `S`.
- `WujiVault` holds collateral and mints one matched YANG/YIN pair per notional.
- `SeriesToken` is the ERC-20 claim for one side of one 30-day series.

There is no owner, pause, upgrade path, or mutable fee. The treasury, collateral, index,
notional, and 5 bps mint/redemption fee are fixed at deployment.

## Verify

```sh
~/.foundry/bin/forge fmt --check
~/.foundry/bin/forge build --sizes
~/.foundry/bin/forge lint
~/.foundry/bin/forge test -vvv
```

The suite includes unit, fuzz, invariant, gap/freeze, real BSC hash, rounding, non-standard
collateral, and settlement-backlog coverage.

## Testnet deployment

Copy `.env.example` to `.env`, use a throwaway funded testnet key, then run:

```sh
./scripts/deploy-testnet.sh
```

The testnet script sets `EXPECTED_CHAIN_ID=97` and explicitly enables deployment of `MockUSDT`.

## Production deployment

Production intentionally has no permissive defaults. Set all of the following:

```sh
ASSET=<canonical collateral address>
TREASURY=<reviewed immutable recipient>
NOTIONAL=<amount in collateral base units>
EXPECTED_CHAIN_ID=56
```

Leave `ALLOW_MOCK_ASSET` unset. `Deploy.s.sol` aborts if the chain id, collateral, or treasury
is missing. Complete [`../docs/MAINNET_CHECKLIST.md`](../docs/MAINNET_CHECKLIST.md) before broadcasting.
