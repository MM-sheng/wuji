// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title WujiIndex — the price of nothing
/// @notice S = Σ over every block since genesis of  UNIT · (byteSum(blockhash) − 4080).
///         byteSum is the sum of the 32 bytes of the hash: mean 4080, sd ≈ 418.04, and by the
///         central limit theorem very close to normal. So each block contributes a near-Gaussian
///         log-increment with σ ≈ UNIT · 418.04 ≈ 1.38e-4 (≈6 %/day at ~192k BSC blocks/day).
///         Price = 100 · e^S is computed off-chain; S itself is what every contract reads.
///
///         No owner, no oracle, no upgrade path. The only input is the chain.
///
/// @dev    blockhash() only reaches back 256 blocks. tick() must therefore be called at least every
///         256 blocks; blocks that fall out of reach before being folded are FROZEN (increment 0)
///         and counted in `frozenBlocks`. Ugly, deterministic, and verifiable — by design.
contract WujiIndex {
    /// @notice wad (1e18) log-increment per unit of (byteSum − 4080)
    int256 public constant UNIT = 3.3e11;
    /// @notice expected byteSum of 32 uniform bytes: 32 · 127.5
    int256 public constant MEAN = 4080;

    uint64 public immutable GENESIS_BLOCK;
    /// @notice cumulative log-index in wad. price = 100 · exp(S / 1e18)
    int256 public S;
    /// @notice last block whose hash has been folded into S
    uint64 public lastBlock;
    /// @notice blocks whose hash aged out before anyone ticked; their increment is 0
    uint64 public frozenBlocks;

    event Tick(uint64 indexed fromBlock, uint64 indexed toBlock, int256 S);
    event Gap(uint64 indexed fromBlock, uint64 indexed toBlock);

    /// @param genesisBlock first block that contributes. Must not be in the past beyond hash reach.
    constructor(uint64 genesisBlock) {
        require(genesisBlock + 255 >= block.number, "genesis out of reach");
        GENESIS_BLOCK = genesisBlock;
        lastBlock = genesisBlock - 1;
    }

    /// @notice Fold every not-yet-folded, still-reachable block hash into S. Anyone may call.
    /// @return folded number of blocks folded this call
    function tick() public returns (uint64 folded) {
        // block numbers fit in uint64 for the next ~10^11 years; byteSum ≤ 8160 fits any int
        // forge-lint: disable-start(unsafe-typecast)
        uint256 cur = block.number;
        uint64 from = lastBlock + 1;
        if (from >= cur) return 0; // current block's hash is not known yet
        uint64 to = uint64(cur - 1);
        uint64 oldest = cur > 256 ? uint64(cur - 256) : 0;
        if (from < oldest) {
            emit Gap(from, oldest - 1);
            frozenBlocks += oldest - from;
            from = oldest;
        }
        int256 s = S;
        unchecked {
            // |increment| ≤ 4080·UNIT ≈ 1.35e15 per block; overflow of int256 is impossible on any horizon
            for (uint256 b = from; b <= to; ++b) {
                s += (int256(byteSum(blockhash(b))) - MEAN) * UNIT;
            }
        }
        S = s;
        lastBlock = to;
        emit Tick(from, to, s);
        return to - from + 1;
        // forge-lint: disable-end(unsafe-typecast)
    }

    /// @notice Sum of the 32 bytes of h, in [0, 8160]. SWAR: 5 fold steps instead of a 32-iteration loop.
    function byteSum(bytes32 h) public pure returns (uint256 x) {
        x = uint256(h);
        x = (x & 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF)
          + ((x >> 8) & 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF);
        x = (x & 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF)
          + ((x >> 16) & 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF);
        x = (x & 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF)
          + ((x >> 32) & 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF);
        x = (x & 0x0000000000000000FFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF)
          + ((x >> 64) & 0x0000000000000000FFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF);
        x = (x & 0x00000000000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF) + (x >> 128);
    }

    /// @notice Increment a single hash would contribute, in wad. Pure, so anyone can verify a step.
    function increment(bytes32 h) public pure returns (int256) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return (int256(byteSum(h)) - MEAN) * UNIT;
    }

    /// @notice How many blocks are waiting to be folded (0 means fully up to date as of the previous block).
    function pending() external view returns (uint256) {
        return block.number - 1 - lastBlock;
    }
}
