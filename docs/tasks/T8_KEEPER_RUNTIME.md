# Keeper runtime follow-up · 2026-09-22

Later the same day, [T8_RECOVERY_REPORT.md](T8_RECOVERY_REPORT.md) records partial fuel recovery,
an explicit local fee cap, restored indexer reads and a full live two-source snapshot replay. The balances
and process observations below describe this earlier runtime change.

## Delivered

The Sepolia v4 keeper now reads and simulates through direct JSON-RPC. Foundry remains responsible for local
ABI encoding/decoding and signing through its existing encrypted keystore. Contract bytecode, pairing, fees,
confirmations and frozen-exit parameters did not change; no deployment was repeated.

Previously, ordinary `cast call` requests spent time probing `anvil_nodeInfo` on a public RPC. A comparison
read of the same immutable relay checkpoint hash returned identical bytes through both paths:

| Path | Elapsed time | Direct reader's RPC methods |
| --- | ---: | --- |
| Existing `cast call` | 38,194 ms | Not instrumented in this comparison |
| Direct RPC plus local ABI codec | 664 ms | One `eth_call` |

This is one sequential sample against `rpc.sepolia.ethpandaops.io`, not a sustained latency guarantee.
Signing still uses Foundry and may incur its own RPC probes. Bitcoin-source throttling, provider outages and
actual gas consumption are separate constraints.

## Signing and exit safeguards

- Estimate the actual calldata and worker, preserving explicit legacy gas prices when configured.
- Reject invalid quantities and zero/over-ceiling estimates; retain 25% headroom within the old operation cap.
- Check the account's latest/pending nonces before signing. Existing pending work must resolve first.
- Reject balances below gas limit × sampled gas price, with a readable required-balance message. An explicit
  legacy fee uses its configured price. Automatic fee selection remains with Foundry, so this is an affordability
  floor; the eventual maximum fee may be higher. It does not make multiple signers on one account safe.
- Recheck chain ID after estimation and account checks. The RPC transport only retries its existing allowlist
  of public reads; gas-estimation failure ends the attempt, and this change adds no automatic send retry.
- Await asynchronous factory discovery before closing frozen vaults. Discovery failure sends nothing. Exit
  eligibility still uses a fixed EVM observation block, binding checks and a final block-hash check.

## Validation and live evidence

- **129 Node tests passed**, including the real keeper process with actual offline Foundry ABI conversion and a
  non-signing transaction double. Existing stale-relay catch-up tests remain; new cases cover low balances,
  pending transactions, wrong chains, changed chains, read reverts, malformed responses and async vault discovery.
- **134 Foundry tests passed across 13 suites**, including all original financial invariants.
- After restarting outside signing operations and checking both account nonces, the revised v4 keeper submitted
  and folded Bitcoin height **968055**. Successful transaction:
  `0x0725c4bc4a4c821ee988c32be0d7a43be3ad4da7a6f977ce5f48773f74a9447e`.
- Exact-height terminal reconciliation and runtime-file hashes are recorded alongside that receipt in
  [sepolia-v4-keeper-runtime.json](../../contracts/deployments/sepolia-v4-keeper-runtime.json).

## Current operation and remaining acceptance

The v4 indexer and revised keeper run locally on port **8794**. The earlier keeper logs show author-operated
progress for roughly six hours before this change; that is not independent-operator acceptance.

The old v3 account had only **640180451620034 wei** of test ETH when inspected and could not afford its next
catch-up batch. Its keeper is deliberately stopped; its indexer remains read-only on port **8793**. The old
relay is stale, and catching up is incomplete. Its historical manifest and receipts are preserved. No additional
funds were moved in this follow-up; the evidence records the v4 account's remaining test fuel.

Public MetaMask signing, full two-source live reconstruction, independent release review, a keeper on another
machine, the 48-hour author-shutdown drill and the first real series settlement remain open. This runtime work
does not complete T8 or establish a sustainable keeper budget.
