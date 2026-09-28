# Related work: Bitcoin headers verified on Ethereum

Surveyed 2026-09-29 from public repositories and documentation. Where a detail was not verified in source
code it says so. This is the basis for the "what is different" section of `GRANT_PROPOSAL.md`.

## The landscape

| Project | What it is | Header rules | Who can submit / admin | ZK | Status |
|---|---|---|---|---|---|
| [BTC Relay](https://github.com/ethereum/btcrelay) (2016) | First Bitcoin SPV relay on Ethereum, Serpent | PoW + linkage documented; retarget/timestamps not documented | Anyone; relayers set fees | No | Mainnet 2016; repository archived Feb 2025 |
| [Summa relays](https://github.com/summa-tx/relays) | Low-storage relay (stores links, not headers), Solidity + Go | Extension + retarget | Anyone; tip moves only when someone calls `markNewHeaviest` | No | Archived Jun 2024 |
| [Interlay BTC-Relay-Solidity](https://github.com/interlay/BTC-Relay-Solidity) | Constant-time inclusion lookups | Not documented in README | Anyone | No | Archived Jun 2024; README: "not audited and contains critical bugs" |
| [BTCSnarkRelay](https://github.com/BromleyLabs/BTCSnarkRelay) | zk-SNARK batch header verification | Linkage, target, batch hash | — | Yes (SNARK) | Proof of concept |
| [tBTC LightRelay](https://github.com/threshold-network/tbtc-v2/blob/main/solidity/contracts/relay/LightRelay.sol) | Stores only headers around difficulty retargets; SPV proofs checked against current/previous difficulty | Retarget algorithm, PoW; epoch-end timestamp bound | **`Ownable`**: owner runs genesis, sets proof length, can require authorised submitters | No | Production (tBTC v2); also used by [BOB](https://github.com/bob-collective/bob) |
| [ERC-8002](https://eips.ethereum.org/EIPS/eip-8002) | Draft standard `ISPVGateway` (Aug 2025) | Linkage, PoW, MTP, 2-hour future bound | Singleton gateway; initial height/work trusted | No (considered, not adopted) | Draft with reference implementation |
| [Tacit](https://github.com/z0r0z/tacit) `BitcoinLightRelay` | Relay inside a confidential DeFi protocol | PoW, branch-local retarget, MTP, heaviest work, per-block storage | `advanceTip` permissionless; deployer-only one-shot genesis | SP1 proves **application state**, not the header chain | Ethereum mainnet since 2026-09-18 |
| [Polyhedra zkBridge](https://blog.polyhedra.network/polyhedra-network-building-the-largest-interoperable-bitcoin-ecosystem-with-zkbridge/) | ZK bridge network claiming Bitcoin header transmission to Ethereum | Not verified here | Operated relay network; contract permissions not verified here | Yes | Commercial product |
| Bitcoin-side ZK (ZeroSync, BitVM bridges, Alpen, Babylon, Citrea) | Verify things *on Bitcoin* | — | — | Yes | Opposite direction; not comparable |

## What this means for WUJI

**Not new:** a permissionless, full-rule Bitcoin header relay in Solidity. Tacit's relay (live on mainnet,
2026-09-18) checks the same rules ours does and is also permissionless after a one-shot genesis. Our
proposal must not claim otherwise.

**Still different, and worth funding:**

1. **The header chain itself is proven in ZK, with the Solidity rules as an escape hatch.** Tacit's SP1
   guests prove application state and its headers still pay ≈per-header gas; BTCSnarkRelay was a proof of
   concept. `ZkWujiIndex` folds a batch of headers through one SP1 proof, with a Rust core that is
   differential-tested against the Solidity and JavaScript implementations over 6,060 real headers, and the
   raw-header path stays callable so liveness never depends on a prover.
2. **Zero administration from deployment.** Genesis is a constructor argument with a public checkpoint, not
   an owner call; there is no owner, authorised-submitter list or parameter setter (compare tBTC's
   `Ownable` relay).
3. **A defined answer to deep reorgs.** A reorg past the confirmation depth is observed on chain, waited out
   for 144 heights, and freezes consumers at the last consistent state. None of the surveyed relays specify
   what applications should do in that case.
4. **Standalone and reusable.** Not embedded in one application; any contract can read headers,
   confirmation depth and the derived index.
5. **A derived public value:** the proof-of-work index, recomputable from Bitcoin alone, with deterministic
   checkpoints. No surveyed project publishes such a value.
6. **Operational tooling included:** a peer-to-peer header client (no third-party API), keeper, watchdog and
   per-height bounties from an on-chain reserve.

**Worth studying before an audit:** Tacit's per-block storage of target and epoch start (so a reorg across a
retarget boundary is O(1) and branch-local) and its seeding of the first eleven ancestors for median-time-past;
ERC-8002's interface as a possible compatibility target for our relay.
