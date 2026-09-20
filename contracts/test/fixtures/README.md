# Bitcoin mainnet fixtures

Run `node scripts/fetch-bitcoin-fixture.mjs` from the repository root. No RPC credentials or dependencies required.
Sources: https://mempool.space/api and https://blockstream.info/api (Esplora `/blocks/:height`, `/block-height/:height`, `/block/:hash/header`).
The script reconstructs all 80 header bytes from public block metadata, verifies their displayed double-SHA256 hashes and contiguous parent links, then writes:

- bitcoin-798336.hex: 2028 headers, heights 798336–800363; spans retarget at 800352.
- bitcoin-vectors.hex: one raw-order SHA256(SHA256d(header)) per header, for Solidity cross-checks.
- bitcoin.json: anchor 798335, epoch start timestamp, known 800000 vector and accumulated U/S.

BitcoinRelayTest checks real mainnet PoW, difficulty and links with the production contract. Economic invariant feeders and EasyRelay are explicitly test-only and do not substitute for these fixtures.

## T2b timestamp fixtures

`node scripts/fetch-bitcoin-timestamps.mjs` retains the original 2028 headers byte-for-byte and adds:

- `bitcoin-timestamps.hex`: 6060 headers, heights 798336–804395, with retargets at 798336, 800352, 802368, 804384.
- `bitcoin-timestamps-ancestors.hex`: eleven chronological raw headers before checkpoint 798335.
- `bitcoin-timestamps-vectors.hex`: 6060 raw-order R digests.
- `bitcoin-timestamps.json`: median times, epoch anchor, U=6888, S_wad=82656000000000000 and metadata.

Solidity tests divide the sequence into three overlapping 2028-header windows (offsets 0, 2016, 4032),
so the ordinary test transaction gas ceiling is unchanged. Each rebuilds its anchor and eleven ancestors,
then compares production validation/state with the frozen pre-T2b packed relay and JS R vectors. Node
recomputes all 6060 headers as one sequence, including PoW, links, compact retarget, MTP and cumulative U/S.

`node scripts/generate-bitcoin-time-vectors.mjs` regenerates `core-timestamps.json`. This optional fixture
regeneration needs a C++17 compiler; neither production Node nor the terminal gains a dependency. It compiles
the verbatim `CBlockIndex::GetMedianTimePast` method from Bitcoin Core v30.0 commit
`d0f6d9953a15d7c7111d46dcb76ab2bb18e5dee3`, with a small harness applying the two timestamp inequalities.
The 345 deterministic vectors cover unsorted/repeated times, equal/one-second boundaries and uint32 extremes.
The JSON records the commit and source file SHA256 values. It is a Core-derived unit differential test,
not a Bitcoin full-node integration test. Solidity exercises real acceptance with test-only parent seeding
and easy PoW; the separate mainnet fixtures exercise unmodified production PoW.

Pinned primary sources:
[median and future limit](https://github.com/bitcoin/bitcoin/blob/d0f6d9953a15d7c7111d46dcb76ab2bb18e5dee3/src/chain.h),
[contextual header checks](https://github.com/bitcoin/bitcoin/blob/d0f6d9953a15d7c7111d46dcb76ab2bb18e5dee3/src/validation.cpp),
[mainnet version activation heights](https://github.com/bitcoin/bitcoin/blob/d0f6d9953a15d7c7111d46dcb76ab2bb18e5dee3/src/kernel/chainparams.cpp).
