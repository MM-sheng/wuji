# T4 · Anyone can verify, anyone can run

Delivered 2026-09-21 on `codex/independent-verification`. Protocol contracts, original test fixtures,
financial tests, fee rules and deployment addresses are unchanged. No public-network transactions were sent.

## Delivered

- `scripts/wuji-verify.mjs`: dependency-free Node CLI, two explicitly selected Esplora sources, independent
  SHA256d/raw-order rehash implementation, exact BigInt U/S, linked anchor-to-six-descendant reconstruction,
  per-checkpoint existence/value checks, pinned EVM reads, final Bitcoin/EVM view checks and PASS/FAIL/WAIT exits.
  Bootstrap WAIT cannot masquerade as verified history. A missing source fails rather than silently falling back.
- `Dockerfile`, `docker-compose.yml`, `.env.docker.example`: digest-pinned Node/Foundry, non-root processes,
  read-only root filesystem, independent persistent cache, explicit keeper profile, read-only encrypted
  keystore/password mounts. The image build has an allow-list context that excludes env, keys and caches.
  The entrypoint binds addresses/chain/genesis to a confirmed current v3 testnet manifest; the existing
  keeper checks its RPC chain before signing. Existing host keepers were not replaced or duplicated.
- Pinned compiler settings, `scripts/verify-bytecode.sh`, `scripts/build-reproducible.mjs` and
  `scripts/verify-bytecode.mjs`: fresh build/cache, native solc 0.8.28, complete runtime comparison including
  metadata, with only validated compiler-declared immutable ranges masked. No metadata stripping.
- CI now includes every existing Node test, the new verification tests, real Anvil constructor deployments,
  cross-directory fresh builds, on-chain bytecode tampering rejection and offline Docker smoke checks.
  README contains the independent verification, five-minute startup and reproducible build commands.

## Reproducibility finding and fix

Foundry expands a relative scoped remapping into an absolute checkout path. That extra path appeared in
v3's compiler metadata. A successful build in the original directory alone therefore did **not** prove
cross-machine reproducibility; our different-directory integration initially rejected it.

The verification build now takes a fresh Foundry Standard JSON source input and recompiles it with the
literal release contexts in `contracts/remappings-v3.json`. The old `/Users/m/...` context is preserved as
an input metadata string; that directory need not exist. The compiler output, its metadata and immutable
references are used without patching. The native compiler version and relevant settings are checked.
The CI integration creates contracts from this fresh output, verifies them from two checkout paths, then
changes one deployed metadata byte and requires CLI exit 1. Ordinary `forge build` still provides normal
local development artifacts; use the reproducible pipeline for exact v3 release comparisons.

## Validation

| Check | Result |
|---|---|
| Solidity suites | **112 passed**, zero failures; original invariants remain 64 × 60, fail_on_revert=true |
| Node unit/integration suite | **58 passed**, zero failures (includes the five legacy gap tests) |
| New independent verifier cases | 16: real 2028-header fixture, 2022 folded heights across retargets, two due checkpoints; known block 800000 byte order; bad source/header/linkage/checkpoint/S, source loss, frozen hash, wrong chain and moving snapshots |
| New runtime comparison cases | 6: immutable masking, changed instruction, changed metadata, missing/short code, invalid ranges and wrong chain |
| New container configuration cases | 3: manifest binding, credentials/fee policy and network/release rejection |
| Real local bytecode integration | **PASS** for 8 deployed runtimes, fresh builds in two different directories, tampered deployed metadata rejected |
| Docker integration | **PASS**: real HTTP proof, cache after restart, non-root/read-only runtime and credential mounts, wrong-chain keeper makes only chain-id reads and no writes |
| Live read-only container | Started at :8794, returned real Sepolia/vault state while independently backfilling; stopped after smoke test, not left as another service |
| Live Sepolia bytecode | **PASS**, 7 runtimes at EVM block **11747279**; see evidence below |
| EIP-170 | All production contracts below limit; largest factory **15282 bytes**, vault **9509**, relay **6894** |

The live read-only container's short run did not complete history backfill. Its health check is HTTP
availability, not a claim of index synchronization. Container keeper tests deliberately use a fake key and
wrong-chain local RPC: they verify startup/guard/mount behavior, not another funded signing run. Actual
Sepolia signing and bounty evidence remains in T3.

Evidence: [sepolia-reproducible-bytecode.json](../../contracts/deployments/sepolia-reproducible-bytecode.json).
Masked bytecode equality does not check immutable values; the separate T3 deployment-binding evidence remains
[sepolia-verification.json](../../contracts/deployments/sepolia-verification.json).

## Live independent reconstruction: incomplete

The first live attempt with mempool.space + Blockstream returned **HTTP 429**. A separately configured
mempool.space + mempool.emzy.de attempt also returned **429** from the second endpoint. Neither produced a PASS.
The last failure is recorded in
[sepolia-independent-verification.json](../../contracts/deployments/sepolia-independent-verification.json).
No source was silently substituted and no indexer cache was used to manufacture a successful result.

Blockstream's response advertised shared-IP limits of 700 requests/hour and 500000/month; the tool now
spaces that host's requests at least six seconds apart and honors Retry-After within bounded retries.
This cannot restore an already exhausted shared quota. Retry when quota is available or explicitly configure
two independently operated Esplora endpoints, preferably including a local full-node-backed service. Endpoint
hostnames by themselves cannot establish operator independence. The endpoint override and scope are documented.

The first real checkpoint is still height **972145**. Its live checkpoint/settlement evidence does not exist yet;
checkpoint comparison is exercised using real Bitcoin headers and mocked settlement RPC state in the offline
suite. This distinction is intentional.

## Remaining boundaries

- Neither a two-source arithmetic replay nor matching runtime code is an independent smart-contract audit.
- RPC responses, source operators and the chosen relay anchor remain trust assumptions; the CLI does not
  implement full Bitcoin consensus or prove a globally highest-work tip.
- Containers make independent operation possible; they do not establish profitable keeper economics or
  complete T8's 48-hour disappearance drill. T9 one-sided frozen exits are still unresolved.
- T5 is next for implementation. The T4 live two-source check remains an explicit follow-up, not a completed gate.
