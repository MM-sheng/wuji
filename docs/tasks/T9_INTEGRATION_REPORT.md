# T9 client integration and local exit drill

## Status

The source candidate from `42d61a6` now has an indexer reader, testnet keeper integration and a standalone
browser exit path. No Solidity production contract, original invariant or fee/pair rule changed in this step.
**A new public Sepolia v4 deployment has not been broadcast.** The existing immutable v3 releases and background
processes are retained. Their addresses have not been relabelled as v4.

Public deployment currently needs additional test ETH. The existing Sepolia deployment account
`0x85967858e2464535A12031103ABA38f2795Fe8Fd` was observed with approximately 0.0156814 test ETH on 2026-09-21.
A sampled Sepolia base fee was approximately 0.977 gwei. New deployment plus replay from the unchanged 967825
anchor, smoke transactions and ongoing keepers need more headroom. These are observations, not a fee guarantee.
The Sepolia dry-run completed successfully: estimated gas 17,625,107; estimated max fee 2.057607588 gwei;
estimated funding requirement 0.036265553902511916 test ETH for deployment alone. This is a simulation,
not a receipt or a fee charged. Public summary: `contracts/deployments/sepolia-v4-preflight.json`.
The PoW faucet form is filled; this new CAPTCHA is awaiting action-time confirmation. No faucet claim is asserted.

## Delivered behaviour

- `indexer/frozen-exit.mjs` reads the notice, folded context, canonical ancestor and relay revision at one EVM
  block. It recomputes notice validity and cross-checks `frozenExitReady()`. The identical dependency-free code
  is embedded in the single-file terminal; a test prevents divergence.
- The v4 indexer includes `chain.frozenExit` and each vault's `closed`, preserves the stored settled share,
  and rejects an EVM snapshot if its block hash changes while being read. Legacy v3 does not call v4 selectors.
- With explicit `FROZEN_EXIT=1`, the **testnet-only** keeper observes an actual on-chain historical mismatch,
  continues submitting headers separately while folding is impossible, and does not reset an already-valid
  notice. A winning branch revision invalidates the observation; an eligible notice can seal the index.
  Closed vaults are skipped. Once frozen, vault closure and accrued bounty claims do not need the Bitcoin HTTP
  source, and this keeper stops doing new relay work. Other callers may still submit headers directly to the relay.
- The terminal has a separate exit panel above the ordinary on-chain view. It remains available when the
  indexer is offline, halted or mismatched. New minting still requires matching independent verification and
  an active index. The exit panel reads the selected published deployment directly before every action.
- The exit panel offers paired redemption, historical/current settled redemption with separate YANG/YIN
  amounts, observation, permanent sealing and per-vault closure. It reads the requested series' own stored
  share. Decimal amounts are encoded exactly to 18 places. Wrong chains, account/endpoint changes, invalid
  amounts and unknown series cannot broadcast. The exact call is simulated before wallet confirmation.
- Browser direct reads verify chain ID, index/relay/vault/asset/notional bindings, candidate delay and snapshot
  freshness. They are RPC-dependent checks, not local validation of EVM consensus or proof of Bitcoin security.
- New Sepolia v4 startup defaults to port 8794, its own cache directory and PID/log prefix. `RUN_KEEPER=0`
  permits read-only startup. Docker derives exit support from the manifest; v3 cannot inherit it accidentally.
- The recorder rejects a v3 broadcast relabelled as v4. `register-terminal-deployment.mjs` adds a v4 release
  to the browser registry only after a fresh full-metadata bytecode comparison and direct binding reads.
  It preserves the v3 registry and refuses accidental v4 replacement. The production page currently publishes
  only the actually deployed v3 addresses; no invented v4 address is shown.

## Local transaction drill

Reproduce from repository root:

```sh
node scripts/test-frozen-exit.mjs
# Optional read-only result page; stop this process to stop its isolated Anvil as well:
DRILL_PREVIEW_PORT=8795 node scripts/test-frozen-exit.mjs
```

The drill starts its own loopback-only Anvil and uses unlocked throwaway accounts, never a private key or a
public funded account. The chain ID is set to 11155111 to exercise the keeper's testnet guard. It deploys a
**test-only relay feeder**, production index and vault, and mock collateral. This is not real Bitcoin PoW,
not a public testnet deployment, and not the 48-hour independent-operator disappearance drill.

22 successful local transactions exercise:

1. Two pairs are minted; one YIN is transferred to another account, creating unequal one-sided holdings.
2. A folded hash is replaced; the keeper records a 144-height observation.
3. A second winning branch revision invalidates the first observation and starts a new deadline.
4. Early sealing reverts. At the new deadline, the keeper seals the index and closes the vault without a successor.
5. Minting after closure reverts. With no recorded own boundary, the actual vault share is 1/2.
6. The **actual browser `doExit` function**, evaluated with a local EIP-1193 adapter, reads the chain while no
   indexer exists. Wrong-chain, changed-account, invalid-amount and unknown-series requests cannot send.
7. The first holder redeems 2 YANG + 1 YIN; the second holder redeems 0 YANG + 1 YIN. Receipts succeed, both
   balances and the original 5 bps fees are checked exactly. Vault collateral and liabilities both end at zero.

The optional HTML preview is generated in memory, clearly labelled local, and disables wallet access. No local
relay address or test adapter is written into the production release registry. The rendered page was checked
in the browser: it reports unavailable index data alongside an independently read closed vault and 50% share.
MetaMask signing against a newly deployed public v4 address remains pending.

## Verification

- 134 Foundry tests, 13 suites: passed; original invariants preserved.
- 101 Node tests: passed (including v3/v4 indexer snapshot tests, keeper action gates, browser history reads,
  wallet guards and publication validation).
- `forge build --sizes`: production contracts remain below EIP-170.
- `node scripts/test-bytecode.mjs`: 8 real local runtimes verified in two fresh build paths;
  altered deployed metadata rejected.
- `node scripts/test-frozen-exit.mjs`: 22-transaction drill passed; included in CI.
- Sepolia deployment dry-run: passed, without broadcasting; estimated funding exceeds observed balance.
- Deployment/startup shell syntax and `git diff --check`: passed.

## Public deployment handoff

1. Review the exact candidate parameters and fund testnet accounts with enough headroom for deployment **and** catch-up.
   Keep the original genesis/anchor/checkpoint interval. Do not silently reset the public index to save gas.
2. Run all required checks. For a broadcast, stop nonce-sharing Sepolia keepers and verify the deployer has no
   pending transaction. Dry-run remains possible without stopping the old service. The helper checks known
   v3/v4 keeper PIDs before broadcasting. Use different encrypted accounts for concurrent keepers; do not run
   two signing loops with the same account/nonce.
3. Commit the exact source. Run `contracts/scripts/deploy-sepolia.sh --broadcast`, then record with
   `DEPLOYMENT_COMMIT=<full source commit> node scripts/record-sepolia-deployment.mjs`. Its default output is
   `contracts/deployments/sepolia-weth-v4.json`; it refuses overwrites and checks the candidate delay on chain.
4. Run fresh bytecode and deployment-binding verification against that manifest. Record new evidence files,
   leaving v3 receipts intact. Use `scripts/register-terminal-deployment.mjs <v4 manifest>` to add the page entry.
5. Source the appropriate encrypted-account configuration, use the v4 manifest and start the isolated stack:

   ```sh
   ENV_FILE="$PWD/contracts/.env.sepolia" \
   MANIFEST=contracts/deployments/sepolia-weth-v4.json RUN_KEEPER=0 bash scripts/bitcoin-testnet.sh
   ```

   This starts only the indexer. Configure a separately funded signing account before starting the v4 keeper;
   preserve/resume the v3 keeper with its original configuration.
6. Let real Bitcoin headers catch up, require exact S/hash reconciliation, then run the small WETH smoke with
   `MANIFEST` and a new `SMOKE_OUTPUT` path. The smoke's wrap/fund amounts are explicit in its source; never
   repeat an uncertain donation blindly. Finally check the actual browser wallet against the public deployment.

The 144-height parameter, midpoint redistribution incentives, unallocated reserve retention, independent audit,
long-running real settlement and independent operator economics remain open mainnet gates.
