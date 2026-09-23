// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RelayerRewards} from "./RelayerRewards.sol";

interface ISP1Verifier {
    /// @dev Reverts when the proof does not attest to `publicValues` under `programVKey`.
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view;
}

/// @title ZkWujiIndex — the same index, advanced either by a proof or by raw headers
/// @notice Two paths, one state machine, identical rules:
///         * `foldProof`  verifies one succinct proof for a whole batch (cost independent of batch size),
///         * `foldHeaders` validates 80-byte headers in Solidity (the escape hatch; liveness never depends
///           on a prover existing).
///         Both advance the same continuity state and produce the same `S`, which a differential test
///         asserts over real mainnet headers.
///
/// @dev Continuity is carried from `tip − CONFIRMATIONS`, never from the validated tip: a reorg shallower
///      than the confirmation depth then cannot orphan the committed state, which is what confirmations are
///      for. The trailing headers of a batch are validated only to prove the folded tip has descendants.
///
///      No owner, no upgrade, no parameter is settable after construction.
contract ZkWujiIndex {
    uint256 public constant POW_LIMIT = 0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
    uint256 public constant MAX_FUTURE_BLOCK_TIME = 2 hours;
    uint64 public constant RETARGET_INTERVAL = 2016;
    uint32 public constant TARGET_TIMESPAN = 14 days;
    int256 public constant UNIT = 1.2e13;
    int256 public constant MEAN = 4080;
    uint64 public constant CONFIRMATIONS = 6;
    /// @notice Cap on headers per `foldHeaders` call, so the escape hatch cannot be given an unbounded batch.
    uint256 public constant MAX_HEADERS = 512;

    ISP1Verifier public immutable verifier;
    bytes32 public immutable programVKey;
    RelayerRewards public immutable rewards;
    uint64 public immutable GENESIS_HEIGHT;
    uint64 public immutable CHECKPOINT_INTERVAL;

    /// @notice Everything the next header is checked against; the state at the last folded height.
    struct Continuity {
        bytes32 hash;
        uint64 height;
        uint32 bits;
        uint32 time;
        uint32 epochStart;
        int64 u; // exact integer accumulator; S = u * UNIT
    }

    Continuity public tip;
    /// @notice Timestamps of the 11 headers ending at `tip.height`, oldest first (median-time-past).
    uint32[11] public recentTimes;
    /// @notice Cumulative work since the anchor (not since the Bitcoin genesis); only differences matter.
    uint256 public chainWork;
    uint64 public nextCheckpointHeight;
    mapping(uint64 => int256) public checkpointS;
    mapping(uint64 => bool) public checkpointed;

    event Fold(uint64 indexed fromHeight, uint64 indexed toHeight, int256 S, bool proved);
    event Checkpoint(uint64 indexed height, int256 S);

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
    error NoVerifier();

    /// @param anchorHeader the 80-byte header at `anchorHeight`; an immutable, publicly auditable starting point
    /// @param ancestorTimes timestamps of the 11 headers ending at `anchorHeight`, oldest first
    constructor(
        ISP1Verifier verifier_,
        bytes32 programVKey_,
        RelayerRewards rewards_,
        bytes memory anchorHeader,
        uint64 anchorHeight,
        uint32 anchorEpochStart,
        uint32[11] memory ancestorTimes,
        uint256 anchorWork, // cumulative work is measured *from this anchor*; the guest starts at 0 too
        uint64 genesisHeight,
        uint64 checkpointInterval
    ) {
        if (anchorHeader.length != 80) revert BadLength();
        if (checkpointInterval == 0 || genesisHeight == 0) revert ConfigMismatch();
        // A verifier with no code would make `verifyProof` succeed silently: Solidity only emits an
        // extcodesize check before external calls that expect return data, and this one returns none.
        // Either point at a real verifier or deploy header-path-only with address(0), which `foldProof`
        // then refuses outright.
        if (address(verifier_) != address(0) && address(verifier_).code.length == 0) revert NoVerifier();
        if (address(rewards_) != address(0)) {
            require(rewards_.index() == address(this) && rewards_.GENESIS_HEIGHT() == genesisHeight, "reward index mismatch");
        }
        verifier = verifier_;
        programVKey = programVKey_;
        rewards = rewards_;
        GENESIS_HEIGHT = genesisHeight;
        CHECKPOINT_INTERVAL = checkpointInterval;

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
        nextCheckpointHeight = genesisHeight + checkpointInterval - 1;
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

    /// @notice The exact tuple a proof must start from; a prover reads this and nothing else.
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

    // ------------------------------------------------------------------ escape hatch: raw headers

    /// @notice Validate `headers` on top of the current state and fold all but the last CONFIRMATIONS.
    /// @dev Costs the same as today's submit+fold. It exists so liveness never depends on a prover.
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

    function foldHeaders(bytes calldata headers, address[] calldata rewardTokens) external returns (uint64 folded) {
        if (headers.length == 0 || headers.length % 80 != 0) revert BadLength();
        Working memory w;
        w.count = headers.length / 80;
        if (w.count > MAX_HEADERS) revert TooManyHeaders();
        if (w.count <= CONFIRMATIONS) revert NotEnoughConfirmations();

        w.state = tip;
        w.times = recentTimes;
        w.work = chainWork;
        _snapshot(w);
        w.from = w.state.height + 1;
        w.foldTarget = w.state.height + uint64(w.count) - CONFIRMATIONS;
        w.maxTime = uint32(block.timestamp + MAX_FUTURE_BLOCK_TIME);

        for (uint256 i = 0; i < w.count; ++i) {
            w.work = _apply(w.state, w.times, w.work, headers[i * 80:(i + 1) * 80], w.maxTime);
            if (w.state.height <= w.foldTarget) {
                if (w.state.height == nextCheckpointHeight) {
                    _recordCheckpoint(w.state.height, int256(w.state.u) * UNIT);
                }
                _snapshot(w);
            }
        }

        tip = w.committed;
        recentTimes = w.committedTimes;
        chainWork = w.committedWork;
        folded = w.committed.height - w.from + 1;
        if (address(rewards) != address(0)) rewards.credit(msg.sender, w.from, w.committed.height, rewardTokens);
        emit Fold(w.from, w.committed.height, int256(w.committed.u) * UNIT, false);
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

    // ------------------------------------------------------------------ fast path: one proof per batch

    /// @notice Public values a proof commits to; the guest recomputes every rule `foldHeaders` applies.
    struct Journal {
        bytes32 prevHash;
        uint64 prevHeight;
        uint32 prevBits;
        uint32 prevTime;
        uint32 prevEpochStart;
        uint32[11] prevTimes;
        int64 prevU;
        uint256 prevWork;
        uint32 maxTime;
        uint64 genesisHeight;
        uint64 checkpointInterval;
        uint64 confirmations;
        bytes32 newHash;
        uint64 newHeight;
        uint32 newBits;
        uint32 newTime;
        uint32 newEpochStart;
        uint32[11] newTimes;
        int64 newU;
        uint256 newWork;
        uint64[] checkpointHeights;
        int64[] checkpointU;
    }

    /// @notice Verify one proof for a whole batch and advance the index. Anyone may call.
    function foldProof(bytes calldata proof, bytes calldata publicValues, address[] calldata rewardTokens)
        external
        returns (uint64 folded)
    {
        if (address(verifier) == address(0)) revert NoVerifier(); // header-path-only deployment
        Journal memory j = abi.decode(publicValues, (Journal));

        // The prover never chooses the configuration or what "now" is.
        if (
            j.genesisHeight != GENESIS_HEIGHT || j.checkpointInterval != CHECKPOINT_INTERVAL
                || j.confirmations != CONFIRMATIONS
        ) revert ConfigMismatch();
        if (j.maxTime > block.timestamp + MAX_FUTURE_BLOCK_TIME) revert FutureTime();

        Continuity memory state = tip;
        if (
            j.prevHash != state.hash || j.prevHeight != state.height || j.prevBits != state.bits
                || j.prevTime != state.time || j.prevEpochStart != state.epochStart || j.prevU != state.u
                || j.prevWork != chainWork
        ) revert Discontinuous();
        uint32[11] memory times = recentTimes;
        for (uint256 i = 0; i < 11; ++i) {
            if (j.prevTimes[i] != times[i]) revert Discontinuous();
        }
        if (j.newHeight <= state.height) revert NotEnoughConfirmations();
        if (j.checkpointHeights.length != j.checkpointU.length) revert BadLength();

        verifier.verifyProof(programVKey, publicValues, proof);

        uint64 from = state.height + 1;
        tip = Continuity({
            hash: j.newHash,
            height: j.newHeight,
            bits: j.newBits,
            time: j.newTime,
            epochStart: j.newEpochStart,
            u: j.newU
        });
        recentTimes = j.newTimes;
        chainWork = j.newWork;
        for (uint256 i = 0; i < j.checkpointHeights.length; ++i) {
            _recordCheckpoint(j.checkpointHeights[i], int256(j.checkpointU[i]) * UNIT);
        }
        folded = j.newHeight - from + 1;
        if (address(rewards) != address(0)) rewards.credit(msg.sender, from, j.newHeight, rewardTokens);
        emit Fold(from, j.newHeight, int256(j.newU) * UNIT, true);
    }

    // ------------------------------------------------------------------ rules (identical to the guest)

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
        if (height >= nextCheckpointHeight) nextCheckpointHeight = height + CHECKPOINT_INTERVAL;
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

    function targetOf(uint32 bits) public pure returns (uint256 target) {
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
