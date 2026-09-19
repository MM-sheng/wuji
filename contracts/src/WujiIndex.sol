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
/// @dev    Hashes come from blockhash() for the last 256 blocks and from the EIP-2935 history contract
///         (live on BSC) for the last 8191 (≈1 h). tick() must be called at least that often; blocks
///         that fall out of reach before being folded are FROZEN (increment 0) and counted in
///         `frozenBlocks`. Ugly, deterministic, and verifiable — by design.
contract WujiIndex {
    /// @notice wad (1e18) log-increment per unit of (byteSum − 4080)
    int256 public constant UNIT = 3.3e11;
    /// @notice expected byteSum of 32 uniform bytes: 32 · 127.5
    int256 public constant MEAN = 4080;

    /// @notice EIP-2935 history storage: staticcall(abi.encode(blockNumber)) → hash, reverts outside the window
    address public constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;
    uint256 public constant HISTORY_WINDOW = 8191;
    /// @notice default cap on blocks folded per tick() call (≈ 1.6k gas each via blockhash, ≈ 4k via history)
    uint256 public constant DEFAULT_MAX = 1024;

    uint64 public immutable GENESIS_BLOCK;
    /// @notice blocks per deterministic settlement period
    uint64 public immutable CHECKPOINT_INTERVAL;
    /// @notice cumulative log-index in wad. price = 100 · exp(S / 1e18)
    int256 public S;
    /// @notice last block whose hash has been folded into S
    uint64 public lastBlock;
    /// @notice blocks whose hash aged out before anyone ticked; their increment is 0
    uint64 public frozenBlocks;
    /// @notice first deterministic boundary not yet folded into the index
    uint64 public nextCheckpointBlock;
    mapping(uint64 => int256) public checkpointS;
    mapping(uint64 => bool) public checkpointed;

    event Tick(uint64 indexed fromBlock, uint64 indexed toBlock, int256 S);
    event Gap(uint64 indexed fromBlock, uint64 indexed toBlock);
    event Checkpoint(uint64 indexed blockNumber, int256 S);

    /// @param genesisBlock first block that contributes. Must not be in the past beyond hash reach.
    constructor(uint64 genesisBlock, uint64 checkpointInterval) {
        require(genesisBlock > 0 && genesisBlock + HISTORY_WINDOW - 1 >= block.number, "genesis out of reach");
        require(checkpointInterval > 0, "checkpoint interval");
        require(genesisBlock <= type(uint64).max - checkpointInterval, "checkpoint overflow");
        GENESIS_BLOCK = genesisBlock;
        CHECKPOINT_INTERVAL = checkpointInterval;
        lastBlock = genesisBlock - 1;
        nextCheckpointBlock = genesisBlock + checkpointInterval - 1;
    }

    /// @notice Fold up to DEFAULT_MAX not-yet-folded, still-reachable block hashes into S. Anyone may call.
    function tick() external returns (uint64 folded) {
        return tick(DEFAULT_MAX);
    }

    /// @notice Fold up to `maxBlocks` pending block hashes into S (oldest first). Anyone may call.
    /// @return folded number of blocks folded this call
    function tick(uint256 maxBlocks) public returns (uint64 folded) {
        // block numbers fit in uint64 for the next ~10^11 years; byteSum ≤ 8160 fits any int
        // forge-lint: disable-start(unsafe-typecast)
        uint256 cur = block.number;
        uint64 from = lastBlock + 1;
        if (from >= cur || maxBlocks == 0) return 0; // current block's hash is not known yet
        uint64 oldest = cur > HISTORY_WINDOW ? uint64(cur - HISTORY_WINDOW) : 0;
        if (from < oldest) {
            emit Gap(from, oldest - 1);
            frozenBlocks += oldest - from;
            _checkpointThrough(oldest - 1, S);
            from = oldest;
        }
        uint256 last = cur - 1;
        if (last - from + 1 > maxBlocks) last = from + maxBlocks - 1;
        uint64 to = uint64(last);
        int256 s = S;
        unchecked {
            // |increment| ≤ 4080·UNIT ≈ 1.35e15 per block; overflow of int256 is impossible on any horizon
            for (uint256 b = from; b <= to; ++b) {
                s += (int256(byteSum(_hash(b, cur))) - MEAN) * UNIT;
                if (b == nextCheckpointBlock) _recordCheckpoint(uint64(b), s);
            }
        }
        S = s;
        lastBlock = to;
        emit Tick(from, to, s);
        return to - from + 1;
        // forge-lint: disable-end(unsafe-typecast)
    }

    function _checkpointThrough(uint64 through, int256 s) internal {
        while (nextCheckpointBlock <= through) {
            _recordCheckpoint(nextCheckpointBlock, s);
        }
    }

    function _recordCheckpoint(uint64 at, int256 s) internal {
        checkpointS[at] = s;
        checkpointed[at] = true;
        emit Checkpoint(at, s);
        require(at <= type(uint64).max - CHECKPOINT_INTERVAL, "checkpoint overflow");
        nextCheckpointBlock = at + CHECKPOINT_INTERVAL;
    }

    /// @dev blockhash() for the recent 256, EIP-2935 beyond. Reverts if the history contract cannot serve a
    ///      block we consider in-window: better to fold nothing than to fold a wrong hash.
    function _hash(uint256 b, uint256 cur) internal view returns (bytes32 h) {
        if (cur - b <= 256) return blockhash(b);
        (bool ok, bytes memory r) = HISTORY.staticcall(abi.encode(b));
        require(ok && r.length == 32, "history unavailable");
        h = abi.decode(r, (bytes32));
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
        // A future genesis is valid: the index simply remains idle until that block exists.
        // Avoid underflow while block.number <= GENESIS_BLOCK.
        if (block.number == 0 || lastBlock >= block.number - 1) return 0;
        return block.number - 1 - lastBlock;
    }
}
