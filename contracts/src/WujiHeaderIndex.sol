// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RelayerRewards} from "./RelayerRewards.sol";

/// @title WujiHeaderIndex — the WUJI index from Bitcoin headers, under three rules and nothing else
/// @notice The mainnet index (T13). Anyone submits raw 80-byte Bitcoin headers; the contract checks them and
///         folds the path into S. Three rules:
///         1. Headers must be valid: proof of work against the target, linkage, difficulty (2016-block retarget
///            with the ×4/÷4 clamp), timestamp above the median of the previous eleven and at most two hours ahead.
///         2. A height counts only once `CONFIRMATIONS` valid headers follow it (mainnet: 100, Bitcoin's coinbase
///            maturity).
///         3. A valid branch from a recorded finalized state that avoids the finalized tip and out-works it by
///            `CONFIRMATIONS + REORG_MARGIN` blocks seals the index for good (`freezeOnReorg`).
///         Submitters are paid per folded height from an immutable operations reserve. No owner, no upgrade, no
///         parameter can change after construction, and no one needs to be online for the rules to hold; the one
///         assumption left is that someone submits the public headers.
/// @dev The rules are the same code as `ZkWujiIndex`'s header path (the proof path and its challenge window are
///      not part of this contract). Continuity is carried from `tip − CONFIRMATIONS`, never from the validated tip.
contract WujiHeaderIndex {
    uint256 public constant POW_LIMIT = 0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
    uint256 public constant MAX_FUTURE_BLOCK_TIME = 2 hours;
    uint64 public constant RETARGET_INTERVAL = 2016;
    uint32 public constant TARGET_TIMESPAN = 14 days;
    int256 public constant UNIT = 1.2e13;
    int256 public constant MEAN = 4080;
    /// @notice Rule 3: a branch must out-work the finalized chain by CONFIRMATIONS + this many blocks.
    uint64 public constant REORG_MARGIN = 144;
    /// @notice Cap on headers per `foldHeaders` call.
    uint256 public constant MAX_HEADERS = 512;
    /// @notice Cap on headers in one `freezeOnReorg` (≈ 15M gas, inside the 2^24 per-transaction cap).
    uint256 public constant MAX_REORG_HEADERS = 800;

    RelayerRewards public immutable rewards;
    uint64 public immutable GENESIS_HEIGHT;
    uint64 public immutable CHECKPOINT_INTERVAL;
    /// @notice Rule 2: a height counts only once CONFIRMATIONS valid headers follow it.
    uint64 public immutable CONFIRMATIONS;

    /// @notice Everything the next header is checked against; the state at the last folded height.
    struct Continuity {
        bytes32 hash;
        uint64 height;
        uint32 bits;
        uint32 time;
        uint32 epochStart;
        int64 u; // exact integer accumulator; S = u * UNIT
    }

    /// @notice The finalized state; what consumers read.
    Continuity public tip;
    /// @notice Timestamps of the 11 headers ending at `tip.height`, oldest first (median-time-past).
    uint32[11] public recentTimes;
    /// @notice Cumulative work since the anchor (not since the Bitcoin genesis); only differences matter.
    uint256 public chainWork;
    mapping(uint64 => int256) public checkpointS;
    mapping(uint64 => bool) public checkpointed;
    /// @notice Commitment to the finalized state after every fold (and the anchor), by height: the only places a
    ///         branch may fork from in `freezeOnReorg`. Written once per height, never changed.
    mapping(uint64 => bytes32) public committedAt;
    /// @notice The highest header ever validated here, folded or not. A lower bound on the Bitcoin tip for
    ///         consumers that must schedule at a height that cannot exist yet. Never counted in S.
    uint64 public seenHeight;
    uint32 public seenTime;
    /// @notice Rule 3: sealed after a proven deep reorg. Irreversible; nothing advances afterwards.
    bool public frozen;

    event Fold(uint64 indexed fromHeight, uint64 indexed toHeight, int256 S);
    event Checkpoint(uint64 indexed height, int256 S);
    event Frozen(uint64 indexed lastHeight, bytes32 lastHash, int256 S, uint64 forkBase, uint64 branchHeight);

    error BadLength();
    error Linkage();
    error Difficulty();
    error MedianTimePast();
    error FutureTime();
    error BadWork();
    error NotEnoughConfirmations();
    error Discontinuous();
    error ConfigMismatch();
    error TooManyHeaders();
    error IndexFrozen();
    error NoReorg();

    /// @param anchorHeader the 80-byte header at `anchorHeight`; an immutable, publicly auditable starting point
    /// @param ancestorTimes timestamps of the 11 headers ending at `anchorHeight`, oldest first
    /// @param anchorWork cumulative work is measured from this anchor (normally 0)
    constructor(
        RelayerRewards rewards_,
        bytes memory anchorHeader,
        uint64 anchorHeight,
        uint32 anchorEpochStart,
        uint32[11] memory ancestorTimes,
        uint256 anchorWork,
        uint64 genesisHeight,
        uint64 checkpointInterval,
        uint64 confirmations
    ) {
        if (anchorHeader.length != 80) revert BadLength();
        if (checkpointInterval == 0 || genesisHeight == 0 || confirmations == 0) revert ConfigMismatch();
        if (address(rewards_) != address(0)) {
            require(
                rewards_.index() == address(this) && rewards_.GENESIS_HEIGHT() == genesisHeight, "reward index mismatch"
            );
        }
        rewards = rewards_;
        GENESIS_HEIGHT = genesisHeight;
        CHECKPOINT_INTERVAL = checkpointInterval;
        CONFIRMATIONS = confirmations;

        uint32 bits = _read32(anchorHeader, 72);
        uint32 time = _read32(anchorHeader, 68);
        if (_pow(anchorHeader) > targetOf(bits)) revert BadWork();
        tip = Continuity({
            hash: sha256(abi.encodePacked(sha256(anchorHeader))),
            height: anchorHeight,
            bits: bits,
            time: time,
            epochStart: anchorEpochStart,
            u: 0
        });
        recentTimes = ancestorTimes;
        chainWork = anchorWork;
        committedAt[anchorHeight] = _commitment(tip, ancestorTimes, anchorWork);
        seenHeight = anchorHeight;
        seenTime = time;
    }

    // ------------------------------------------------------------------ views

    function S() public view returns (int256) {
        return int256(tip.u) * UNIT;
    }

    function lastHeight() external view returns (uint64) {
        return tip.height;
    }

    function lastHash() external view returns (bytes32) {
        return tip.hash;
    }

    /// @notice The finalized state a submitter extends: `foldHeaders` starts from it, and it is the base the
    ///         latest entry of `committedAt` commits to.
    function continuity() external view returns (Continuity memory, uint32[11] memory, uint256) {
        return (tip, recentTimes, chainWork);
    }

    function medianTimePast() public view returns (uint32) {
        uint32[11] memory t = recentTimes;
        for (uint256 i = 1; i < 11; ++i) {
            uint32 key = t[i];
            uint256 j = i;
            while (j > 0 && t[j - 1] > key) {
                t[j] = t[j - 1];
                --j;
            }
            t[j] = key;
        }
        return t[5];
    }

    // ------------------------------------------------------------------ rules 1 and 2: fold headers

    /// @dev One memory struct keeps `foldHeaders` off the stack limit; every field is copied by value.
    struct Working {
        Continuity state;
        Continuity committed;
        uint32[11] times;
        uint32[11] committedTimes;
        uint256 work;
        uint256 committedWork;
        uint64 from;
        uint64 foldTarget;
        uint32 maxTime;
        uint256 count;
    }

    /// @notice Validate `headers` on top of the finalized state and fold all but the last CONFIRMATIONS.
    ///         Anyone may call; the caller is credited the relayer bounty for every newly folded height in the
    ///         sorted, unique `rewardTokens` (empty: no bounty, the heights are still consumed).
    function foldHeaders(bytes calldata headers, address[] calldata rewardTokens) external returns (uint64 folded) {
        if (frozen) revert IndexFrozen();
        Working memory w;
        w.state = tip;
        w.times = recentTimes;
        w.work = chainWork;
        (uint64[] memory heights, int64[] memory us) = _replay(w, headers);
        for (uint256 i = 0; i < heights.length; ++i) {
            _recordCheckpoint(heights[i], int256(us[i]) * UNIT);
        }
        tip = w.committed;
        recentTimes = w.committedTimes;
        chainWork = w.committedWork;
        committedAt[w.committed.height] = _commitment(w.committed, w.committedTimes, w.committedWork);
        // After a replay `w.state` is the last header validated: the newest Bitcoin block this contract has seen.
        if (w.state.height > seenHeight) {
            seenHeight = w.state.height;
            seenTime = w.state.time;
        }
        folded = w.committed.height - w.from + 1;
        if (address(rewards) != address(0)) rewards.credit(msg.sender, w.from, w.committed.height, rewardTokens);
        emit Fold(w.from, w.committed.height, int256(w.committed.u) * UNIT);
    }

    /// @dev Validate `headers` on top of `w.state`, leaving the state at `tip − CONFIRMATIONS` in
    ///      `w.committed*` and returning the checkpoint boundaries crossed up to it. Writes no storage.
    function _replay(Working memory w, bytes calldata headers)
        internal
        view
        returns (uint64[] memory heights, int64[] memory us)
    {
        if (headers.length == 0 || headers.length % 80 != 0) revert BadLength();
        w.count = headers.length / 80;
        if (w.count > MAX_HEADERS) revert TooManyHeaders();
        if (w.count <= CONFIRMATIONS) revert NotEnoughConfirmations();
        _snapshot(w);
        w.from = w.state.height + 1;
        w.foldTarget = w.state.height + uint64(w.count) - CONFIRMATIONS;
        w.maxTime = uint32(block.timestamp + MAX_FUTURE_BLOCK_TIME);

        uint256 n = _boundariesUpTo(w.foldTarget) - _boundariesUpTo(w.state.height);
        heights = new uint64[](n);
        us = new int64[](n);
        n = 0;
        for (uint256 i = 0; i < w.count; ++i) {
            w.work = _apply(w.state, w.times, w.work, headers[i * 80:(i + 1) * 80], w.maxTime);
            if (w.state.height <= w.foldTarget) {
                if (_isBoundary(w.state.height)) {
                    heights[n] = w.state.height;
                    us[n] = w.state.u;
                    ++n;
                }
                _snapshot(w);
            }
        }
    }

    /// @dev Copy the live state into the committed slot **by value**. A plain struct assignment between
    ///      memory variables only aliases the reference, which would let later headers mutate the snapshot
    ///      and silently defeat the confirmation depth.
    function _snapshot(Working memory w) internal pure {
        w.committed.hash = w.state.hash;
        w.committed.height = w.state.height;
        w.committed.bits = w.state.bits;
        w.committed.time = w.state.time;
        w.committed.epochStart = w.state.epochStart;
        w.committed.u = w.state.u;
        for (uint256 i = 0; i < 11; ++i) {
            w.committedTimes[i] = w.times[i];
        }
        w.committedWork = w.work;
    }

    // ------------------------------------------------------------------ rule 3: deep reorg seals the index

    /// @notice Seal the index for good when Bitcoin has reorganized past its finalized tip. `headers` must form
    ///         a branch, valid under every header rule, from a recorded finalized state below the tip
    ///         (`committedAt`), that does not pass through the tip and that out-works the finalized chain by
    ///         `CONFIRMATIONS + REORG_MARGIN` blocks at the tip's difficulty. No notice, no waiting, no one to
    ///         cancel: the wait is in the work. Afterwards S and its checkpoints stay at the last consistent
    ///         state and nothing advances; consumers exit on what was recorded (as under T9).
    /// @dev Same trust as the rest of the header path: anything with valid work counts. A fake seal needs about
    ///      CONFIRMATIONS + 144 privately mined blocks, more than the finalized chain had.
    /// @param base `abi.encode(Continuity, uint32[11] times, uint256 work)` of a state recorded in `committedAt`
    function freezeOnReorg(bytes calldata base, bytes calldata headers) external {
        if (frozen) revert IndexFrozen();
        (Continuity memory state, uint32[11] memory times, uint256 work) =
            abi.decode(base, (Continuity, uint32[11], uint256));
        uint64 tipHeight = tip.height;
        if (state.height >= tipHeight) revert NoReorg();
        if (committedAt[state.height] != keccak256(base)) revert Discontinuous();
        if (headers.length == 0 || headers.length % 80 != 0) revert BadLength();
        if (headers.length / 80 > MAX_REORG_HEADERS) revert TooManyHeaders();

        uint64 forkBase = state.height;
        bytes32 tipHash = tip.hash;
        uint32 maxTime = uint32(block.timestamp + MAX_FUTURE_BLOCK_TIME);
        for (uint256 i = 0; i < headers.length; i += 80) {
            work = _apply(state, times, work, headers[i:i + 80], maxTime);
            // Through the finalized tip means the same chain: that is an extension, not a reorg.
            if (state.height == tipHeight && state.hash == tipHash) revert NoReorg();
        }
        if (state.height <= tipHeight) revert NoReorg();
        if (work < chainWork + uint256(CONFIRMATIONS + REORG_MARGIN) * workOf(targetOf(tip.bits))) revert NoReorg();

        frozen = true;
        emit Frozen(tipHeight, tipHash, S(), forkBase, state.height);
    }

    function _commitment(Continuity memory c, uint32[11] memory times, uint256 work) internal pure returns (bytes32) {
        return keccak256(abi.encode(c, times, work));
    }

    // ------------------------------------------------------------------ header rules (identical to the guest)

    /// @dev Mutates `state` and `times` in place (they are memory references) and returns the new work.
    function _apply(
        Continuity memory state,
        uint32[11] memory times,
        uint256 work,
        bytes calldata raw,
        uint32 maxTime
    ) internal pure returns (uint256) {
        uint64 height = state.height + 1;
        uint32 bits = _read32c(raw, 72);
        uint32 time = _read32c(raw, 68);

        if (bytes32(raw[4:36]) != state.hash) revert Linkage();
        uint32 expected =
            height % RETARGET_INTERVAL == 0 ? retarget(state.bits, state.epochStart, state.time) : state.bits;
        if (bits != expected) revert Difficulty();
        if (time <= _median(times)) revert MedianTimePast();
        if (time > maxTime) revert FutureTime();

        uint256 target = targetOf(bits);
        bytes32 hash = sha256(abi.encodePacked(sha256(raw)));
        if (uint256(reverse(hash)) > target) revert BadWork();

        state.u += int64(int256(byteSum(sha256(abi.encodePacked(hash)))) - MEAN);
        state.hash = hash;
        state.height = height;
        state.bits = bits;
        state.time = time;
        if (height % RETARGET_INTERVAL == 0) state.epochStart = time;
        for (uint256 i = 0; i < 10; ++i) {
            times[i] = times[i + 1];
        }
        times[10] = time;
        return work + workOf(target);
    }

    function _recordCheckpoint(uint64 height, int256 s) internal {
        if (checkpointed[height]) return;
        checkpointS[height] = s;
        checkpointed[height] = true;
        emit Checkpoint(height, s);
    }

    function _median(uint32[11] memory input) internal pure returns (uint32) {
        uint32[11] memory t = input;
        for (uint256 i = 1; i < 11; ++i) {
            uint32 key = t[i];
            uint256 j = i;
            while (j > 0 && t[j - 1] > key) {
                t[j] = t[j - 1];
                --j;
            }
            t[j] = key;
        }
        return t[5];
    }

    /// @dev Series boundaries are the heights `GENESIS_HEIGHT − 1 + m·CHECKPOINT_INTERVAL`, m ≥ 1 (the guest's rule).
    function _isBoundary(uint64 height) internal view returns (bool) {
        return height >= GENESIS_HEIGHT && (height + 1 - GENESIS_HEIGHT) % CHECKPOINT_INTERVAL == 0;
    }

    function _boundariesUpTo(uint64 height) internal view returns (uint256) {
        return height + 1 < GENESIS_HEIGHT ? 0 : (height + 1 - GENESIS_HEIGHT) / CHECKPOINT_INTERVAL;
    }

    /// @dev Virtual only so a test-only subclass can lower the difficulty floor to mine real forks in tests
    ///      (as T9 does with its relay); no production contract overrides it.
    function targetOf(uint32 bits) public pure virtual returns (uint256 target) {
        uint256 size = bits >> 24;
        uint256 word = bits & 0x007fffff;
        require(word != 0 && bits & 0x00800000 == 0, "target sign/zero");
        require(size <= 34 && !(word > 0xff && size > 33) && !(word > 0xffff && size > 32), "target overflow");
        target = size <= 3 ? word >> (8 * (3 - size)) : word << (8 * (size - 3));
        require(target > 0 && target <= POW_LIMIT, "target range");
    }

    function compact(uint256 target) public pure returns (uint32) {
        uint256 size;
        uint256 t = target;
        while (t > 0) {
            ++size;
            t >>= 8;
        }
        uint256 word = size <= 3 ? target << (8 * (3 - size)) : target >> (8 * (size - 3));
        if (word & 0x00800000 != 0) {
            word >>= 8;
            ++size;
        }
        return uint32(word | size << 24);
    }

    function retarget(uint32 bits, uint32 first, uint32 last) public pure returns (uint32) {
        int256 elapsed = int256(uint256(last)) - int256(uint256(first));
        if (elapsed < int32(TARGET_TIMESPAN) / 4) elapsed = int32(TARGET_TIMESPAN) / 4;
        if (elapsed > int32(TARGET_TIMESPAN) * 4) elapsed = int32(TARGET_TIMESPAN) * 4;
        uint256 next = targetOf(bits) * uint256(elapsed) / TARGET_TIMESPAN;
        return compact(next > POW_LIMIT ? POW_LIMIT : next);
    }

    function workOf(uint256 target) public pure returns (uint256) {
        return ~target / (target + 1) + 1;
    }

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

    function reverse(bytes32 value) public pure returns (bytes32) {
        uint256 v = uint256(value);
        uint256 r;
        for (uint256 i; i < 32; ++i) {
            r = (r << 8) | (v & 255);
            v >>= 8;
        }
        return bytes32(r);
    }

    function _pow(bytes memory h) internal pure returns (uint256) {
        return uint256(reverse(sha256(abi.encodePacked(sha256(h)))));
    }

    function _read32(bytes memory h, uint256 at) internal pure returns (uint32) {
        return uint32(uint8(h[at])) | uint32(uint8(h[at + 1])) << 8 | uint32(uint8(h[at + 2])) << 16
            | uint32(uint8(h[at + 3])) << 24;
    }

    function _read32c(bytes calldata h, uint256 at) internal pure returns (uint32) {
        return uint32(uint8(h[at])) | uint32(uint8(h[at + 1])) << 8 | uint32(uint8(h[at + 2])) << 16
            | uint32(uint8(h[at + 3])) << 24;
    }
}
