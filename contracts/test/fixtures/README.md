# Bitcoin mainnet fixtures

Run `node scripts/fetch-bitcoin-fixture.mjs` from the repository root. No RPC credentials or dependencies required.
Sources: https://mempool.space/api and https://blockstream.info/api (Esplora `/blocks/:height`, `/block-height/:height`, `/block/:hash/header`).
The script reconstructs all 80 header bytes from public block metadata, verifies their displayed double-SHA256 hashes and contiguous parent links, then writes:

- bitcoin-798336.hex: 2028 headers, heights 798336–800363; spans retarget at 800352.
- bitcoin-vectors.hex: one raw-order SHA256(SHA256d(header)) per header, for Solidity cross-checks.
- bitcoin.json: anchor 798335, epoch start timestamp, known 800000 vector and accumulated U/S.

BitcoinRelayTest checks real mainnet PoW, difficulty and links with the production contract. Economic invariant feeders and EasyRelay are explicitly test-only and do not substitute for these fixtures.
