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
///         A proof does not move the index directly (T12). It opens a *pending batch* that becomes final
///         `CHALLENGE_WINDOW` later unless someone `dispute`s it with a bond. A disputed batch is kept only if
///         someone `back`s it with the raw headers, checked here by the Solidity rules; otherwise anyone may
///         `reject` it. A forged proof therefore moves the index only if the proof system is broken *and*
///         nobody honest objects in time. Everything consumers read (`S`, `lastHeight`, checkpoints,
///         relayer bounties) reflects finalized batches only.
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
    /// @notice Cap on headers behind one proof (folded heights + CONFIRMATIONS), so backing it with raw
    ///         headers always fits in one transaction (≈ 99k gas per header).
    uint256 public constant MAX_PROOF_HEADERS = 250;
    /// @notice Cap on the pending queue, so `reject` can always delete the tail it invalidates.
    uint256 public constant MAX_PENDING = 32;

    ISP1Verifier public immutable verifier;
    bytes32 public immutable programVKey;
    RelayerRewards public immutable rewards;
    uint64 public immutable GENESIS_HEIGHT;
    uint64 public immutable CHECKPOINT_INTERVAL;
    uint64 public immutable CHALLENGE_WINDOW;
    uint64 public immutable RESPONSE_WINDOW;
    /// @notice Native-currency bond a disputer posts; it pays whoever backs the batch if the dispute was wrong.
    uint256 public immutable DISPUTE_BOND;

    /// @notice Everything the next header is checked against; the state at the last folded height.
    struct Continuity {
        bytes32 hash;
        uint64 height;
        uint32 bits;
        uint32 time;
        uint32 epochStart;
        int64 u; // exact integer accumulator; S = u * UNIT
    }

    /// @notice Challenge-window parameters, fixed at construction.
    struct Challenge {
        uint64 window;
        uint64 responseWindow;
        uint256 bond;
    }

    /// @notice A proved batch waiting for its challenge window. Its starting state is the finalized tip
    ///         (for the oldest) or the previous batch's `to`: batches chain.
    struct Batch {
        Continuity to;
        uint32[11] toTimes;
        uint256 toWork;
        uint64[] checkpointHeights;
        int64[] checkpointU;
        address prover;
        uint64 finalAt;
        address disputer;
        uint64 respondBy;
        bool backed;
        address[] proverTokens;
        address[] disputerTokens;
    }

    /// @notice The finalized state; what consumers read.
    Continuity public tip;
    /// @notice Timestamps of the 11 headers ending at `tip.height`, oldest first (median-time-past).
    uint32[11] public recentTimes;
    /// @notice Cumulative work since the anchor (not since the Bitcoin genesis); only differences matter.
    uint256 public chainWork;
    mapping(uint64 => int256) public checkpointS;
    mapping(uint64 => bool) public checkpointed;

    /// @notice Pending batches are ids `firstPending .. nextBatch-1`, oldest first.
    mapping(uint256 => Batch) internal batches;
    uint256 public firstPending;
    uint256 public nextBatch;
    /// @notice Native currency owed to disputers and backers; pulled with `withdraw`.
    mapping(address => uint256) public owed;

    event Fold(uint64 indexed fromHeight, uint64 indexed toHeight, int256 S, bool proved);
    event Checkpoint(uint64 indexed height, int256 S);
    event Proposed(uint256 indexed id, uint64 fromHeight, uint64 toHeight, bytes32 toHash, int256 S, uint64 finalAt);
    event Disputed(uint256 indexed id, address indexed disputer, uint64 respondBy);
    event Backed(uint256 indexed id, address indexed backer);
    event Rejected(uint256 indexed id, uint256 removed, address indexed disputer);

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
    error BadCheckpoints();
    error BadTokens();
    error BatchesPending();
    error QueueFull();
    error NoSuchBatch();
    error AlreadyDisputed();
    error NotDisputed();
    error WindowClosed();
    error WindowOpen();
    error WrongBond();
    error Mismatch();
    error NotForged();
    error TransferFailed();

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
        uint64 checkpointInterval,
        Challenge memory challenge
    ) {
        if (anchorHeader.length != 80) revert BadLength();
        if (checkpointInterval == 0 || genesisHeight == 0) revert ConfigMismatch();
        // A proof path without a window, a response time or a bond would let any dispute (or none) decide.
        if (
            address(verifier_) != address(0)
                && (challenge.window == 0 || challenge.responseWindow == 0 || challenge.bond == 0)
        ) revert ConfigMismatch();
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
        CHALLENGE_WINDOW = challenge.window;
        RESPONSE_WINDOW = challenge.responseWindow;
        DISPUTE_BOND = challenge.bond;

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

    /// @notice Timestamp of the finalized tip's header.
    function lastTime() external view returns (uint32) {
        return tip.time;
    }

    /// @notice Validate `headers` on top of the finalized state with every header rule and return the last
    ///         height and its timestamp. Writes nothing. Any chain that passes carries real proof of work at the
    ///         real difficulty, so its height is a lower bound on the Bitcoin tip: what a consumer needs to
    ///         schedule work at a height that cannot exist yet (T11 pools on this index).
    function seenTip(bytes calldata headers) external view returns (uint64 height, uint32 time) {
        if (headers.length == 0 || headers.length % 80 != 0) revert BadLength();
        uint256 count = headers.length / 80;
        if (count > MAX_HEADERS) revert TooManyHeaders();
        Continuity memory state = tip;
        uint32[11] memory times = recentTimes;
        uint256 work = chainWork;
        uint32 maxTime = uint32(block.timestamp + MAX_FUTURE_BLOCK_TIME);
        for (uint256 i = 0; i < count; ++i) {
            work = _apply(state, times, work, headers[i * 80:(i + 1) * 80], maxTime);
        }
        return (state.height, state.time);
    }

    /// @notice The exact tuple the next proof must start from: the newest pending batch's end, or the
    ///         finalized state when nothing is pending. A prover reads this and nothing else.
    function continuity() external view returns (Continuity memory, uint32[11] memory, uint256) {
        return _stateBefore(nextBatch);
    }

    /// @notice The state pending batch `id` starts from (`firstPending <= id <= nextBatch`): what a watcher
    ///         replays real headers from, and what `back` checks them against.
    function stateBefore(uint256 id) external view returns (Continuity memory, uint32[11] memory, uint256) {
        if (id < firstPending || id > nextBatch) revert NoSuchBatch();
        return _stateBefore(id);
    }

    function pendingCount() external view returns (uint256) {
        return nextBatch - firstPending;
    }

    /// @notice A pending batch by id (`firstPending <= id < nextBatch`); empty otherwise.
    function batch(uint256 id) external view returns (Batch memory) {
        return batches[id];
    }

    /// @dev The state batch `id` starts from: the previous pending batch's end, or the finalized state.
    function _stateBefore(uint256 id) internal view returns (Continuity memory, uint32[11] memory, uint256) {
        if (id == firstPending) return (tip, recentTimes, chainWork);
        Batch storage b = batches[id - 1];
        return (b.to, b.toTimes, b.toWork);
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

    /// @notice Validate `headers` on top of the finalized state and fold all but the last CONFIRMATIONS.
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

    /// @notice Runs only from the finalized state with nothing pending, so it cannot race a dispute.
    function foldHeaders(bytes calldata headers, address[] calldata rewardTokens) external returns (uint64 folded) {
        if (firstPending != nextBatch) revert BatchesPending();
        Working memory w;
        w.state = tip;
        w.times = recentTimes;
        w.work = chainWork;
        (uint64[] memory heights, int64[] memory us) = _replay(w, headers);
        folded = _commitReplay(w, heights, us, rewardTokens);
    }

    /// @dev Make a replay from the finalized state the new finalized state, as the header path always has.
    function _commitReplay(Working memory w, uint64[] memory heights, int64[] memory us, address[] calldata rewardTokens)
        internal
        returns (uint64 folded)
    {
        for (uint256 i = 0; i < heights.length; ++i) {
            _recordCheckpoint(heights[i], int256(us[i]) * UNIT);
        }
        tip = w.committed;
        recentTimes = w.committedTimes;
        chainWork = w.committedWork;
        folded = w.committed.height - w.from + 1;
        if (address(rewards) != address(0)) rewards.credit(msg.sender, w.from, w.committed.height, rewardTokens);
        emit Fold(w.from, w.committed.height, int256(w.committed.u) * UNIT, false);
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

    /// @notice Verify one proof for a whole batch and queue it as pending. Anyone may call.
    /// @param rewardTokens the relayer-bounty tokens credited to the caller when the batch finalizes; fixed
    ///        now so whoever calls `finalize` cannot choose them.
    function foldProof(bytes calldata proof, bytes calldata publicValues, address[] calldata rewardTokens)
        external
        returns (uint256 id)
    {
        if (address(verifier) == address(0)) revert NoVerifier(); // header-path-only deployment
        Journal memory j = abi.decode(publicValues, (Journal));

        // The prover never chooses the configuration or what "now" is.
        if (
            j.genesisHeight != GENESIS_HEIGHT || j.checkpointInterval != CHECKPOINT_INTERVAL
                || j.confirmations != CONFIRMATIONS
        ) revert ConfigMismatch();
        if (j.maxTime > block.timestamp + MAX_FUTURE_BLOCK_TIME) revert FutureTime();

        id = nextBatch;
        if (id - firstPending >= MAX_PENDING) revert QueueFull();
        (Continuity memory state, uint32[11] memory times, uint256 work) = _stateBefore(id);
        if (
            j.prevHash != state.hash || j.prevHeight != state.height || j.prevBits != state.bits
                || j.prevTime != state.time || j.prevEpochStart != state.epochStart || j.prevU != state.u
                || j.prevWork != work
        ) revert Discontinuous();
        for (uint256 i = 0; i < 11; ++i) {
            if (j.prevTimes[i] != times[i]) revert Discontinuous();
        }
        if (j.newHeight <= state.height) revert NotEnoughConfirmations();
        if (j.newHeight - state.height + CONFIRMATIONS > MAX_PROOF_HEADERS) revert TooManyHeaders();
        _checkBoundaries(state.height, j.newHeight, j.checkpointHeights, j.checkpointU.length);
        _checkTokens(rewardTokens);

        verifier.verifyProof(programVKey, publicValues, proof);

        Batch storage b = batches[id];
        b.to = Continuity({
            hash: j.newHash,
            height: j.newHeight,
            bits: j.newBits,
            time: j.newTime,
            epochStart: j.newEpochStart,
            u: j.newU
        });
        b.toTimes = j.newTimes;
        b.toWork = j.newWork;
        b.checkpointHeights = j.checkpointHeights;
        b.checkpointU = j.checkpointU;
        b.prover = msg.sender;
        b.finalAt = uint64(block.timestamp) + CHALLENGE_WINDOW;
        b.proverTokens = rewardTokens;
        nextBatch = id + 1;
        emit Proposed(id, state.height + 1, j.newHeight, j.newHash, int256(j.newU) * UNIT, b.finalAt);
    }

    // ------------------------------------------------------------------ challenge window

    /// @notice Apply up to `maxBatches` pending batches, oldest first, that are past their window and
    ///         undisputed, or backed. Stops at the first that is not ready. Anyone may call.
    function finalize(uint256 maxBatches) external returns (uint256 done) {
        while (done < maxBatches && firstPending < nextBatch) {
            uint256 id = firstPending;
            Batch storage b = batches[id];
            if (!b.backed && (b.disputer != address(0) || block.timestamp < b.finalAt)) break;

            uint64 from = tip.height + 1;
            tip = b.to;
            recentTimes = b.toTimes;
            chainWork = b.toWork;
            for (uint256 i = 0; i < b.checkpointHeights.length; ++i) {
                _recordCheckpoint(b.checkpointHeights[i], int256(b.checkpointU[i]) * UNIT);
            }
            if (address(rewards) != address(0)) rewards.credit(b.prover, from, b.to.height, b.proverTokens);
            emit Fold(from, b.to.height, int256(b.to.u) * UNIT, true);
            delete batches[id];
            firstPending = id + 1;
            ++done;
        }
    }

    /// @notice Object to a pending batch before its window closes, posting `DISPUTE_BOND`.
    /// @param rewardTokens the relayer-reserve tokens the disputer is paid in if the batch is rejected.
    function dispute(uint256 id, address[] calldata rewardTokens) external payable {
        Batch storage b = _pending(id);
        if (b.disputer != address(0)) revert AlreadyDisputed();
        if (block.timestamp >= b.finalAt) revert WindowClosed();
        if (msg.value != DISPUTE_BOND) revert WrongBond();
        _checkTokens(rewardTokens);
        b.disputer = msg.sender;
        b.respondBy = uint64(block.timestamp) + RESPONSE_WINDOW;
        b.disputerTokens = rewardTokens;
        emit Disputed(id, msg.sender, b.respondBy);
    }

    /// @notice Answer a dispute with the raw headers of the batch plus its CONFIRMATIONS trailing headers.
    ///         They are checked by the same Solidity rules as `foldHeaders`, from the batch's starting
    ///         state, and must reproduce the claimed end state exactly. The caller earns the bond.
    function back(uint256 id, bytes calldata headers) external {
        Batch storage b = _pending(id);
        if (b.disputer == address(0) || b.backed) revert NotDisputed();
        if (block.timestamp > b.respondBy) revert WindowClosed();

        Working memory w;
        (w.state, w.times, w.work) = _stateBefore(id);
        if (headers.length != (uint256(b.to.height - w.state.height) + CONFIRMATIONS) * 80) revert BadLength();
        (, int64[] memory us) = _replay(w, headers);
        if (!_matches(w, b, us)) revert Mismatch();

        b.backed = true;
        owed[msg.sender] += DISPUTE_BOND;
        emit Backed(id, msg.sender);
    }

    /// @notice Remove a disputed batch nobody backed in time, and every pending batch after it (they were
    ///         built on it). Disputers get their bonds back. No bounty: an unbacked batch is not shown to be
    ///         forged, and paying for it would let anyone dispute honest batches for profit whenever backing
    ///         costs more gas than the bond is worth. Proven forgeries are paid through `refute`.
    function reject(uint256 id) external {
        Batch storage b = _pending(id);
        if (b.disputer == address(0) || b.backed) revert NotDisputed();
        if (block.timestamp <= b.respondBy) revert WindowOpen();
        _reject(id, false);
    }

    /// @notice Prove a disputed batch false at once, instead of waiting out the response window: the real
    ///         headers over the batch's range, replayed by the Solidity rules from its starting state, reach a
    ///         different end state. The batch and everything after it go as in `reject`, and the disputer is
    ///         paid the relayer bounty the batch would have earned. For the oldest batch
    ///         the replayed state is then folded exactly as `foldHeaders` would fold it, so a stream of forged
    ///         proofs holding the head of the queue cannot hold the index: the header path stays live.
    /// @dev Same trust as `foldHeaders`: any branch with valid proof of work and CONFIRMATIONS descendants.
    function refute(uint256 id, bytes calldata headers, address[] calldata rewardTokens)
        external
        returns (uint64 folded)
    {
        Batch storage b = _pending(id);
        if (b.disputer == address(0) || b.backed) revert NotDisputed();
        Working memory w;
        (w.state, w.times, w.work) = _stateBefore(id);
        if (headers.length != (uint256(b.to.height - w.state.height) + CONFIRMATIONS) * 80) revert BadLength();
        (uint64[] memory heights, int64[] memory us) = _replay(w, headers);
        if (_matches(w, b, us)) revert NotForged();
        bool oldest = id == firstPending;
        _reject(id, true);
        if (oldest) folded = _commitReplay(w, heights, us, rewardTokens);
    }

    /// @param proven whether the batch was shown to differ from real headers (`refute`); only then is the
    ///        disputer paid a bounty.
    function _reject(uint256 id, bool proven) internal {
        Batch storage b = batches[id];
        address disputer = b.disputer;
        address[] memory tokens = b.disputerTokens;
        (Continuity memory from,,) = _stateBefore(id);
        uint256 heights = b.to.height - from.height;

        uint256 removed = nextBatch - id;
        for (uint256 k = nextBatch; k > id;) {
            --k;
            Batch storage later = batches[k];
            if (later.disputer != address(0) && !later.backed) owed[later.disputer] += DISPUTE_BOND;
            delete batches[k];
        }
        nextBatch = id;
        // The bounty is a reward, never a condition: a failing reserve must not keep a forged batch queued.
        if (proven && address(rewards) != address(0)) {
            try rewards.award(disputer, heights, tokens) {} catch {}
        }
        emit Rejected(id, removed, disputer);
    }

    function withdraw() external returns (uint256 amount) {
        amount = owed[msg.sender];
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _pending(uint256 id) internal view returns (Batch storage) {
        if (id < firstPending || id >= nextBatch) revert NoSuchBatch();
        return batches[id];
    }

    function _matches(Working memory w, Batch storage b, int64[] memory us) internal view returns (bool) {
        Continuity memory c = w.committed;
        Continuity storage t = b.to;
        if (
            c.hash != t.hash || c.height != t.height || c.bits != t.bits || c.time != t.time
                || c.epochStart != t.epochStart || c.u != t.u || w.committedWork != b.toWork
        ) return false;
        for (uint256 i = 0; i < 11; ++i) {
            if (w.committedTimes[i] != b.toTimes[i]) return false;
        }
        // Heights were checked against the boundary rule when the batch was proposed; compare the values.
        if (us.length != b.checkpointU.length) return false;
        for (uint256 i = 0; i < us.length; ++i) {
            if (us[i] != b.checkpointU[i]) return false;
        }
        return true;
    }

    /// @dev The claimed checkpoint heights must be exactly the boundaries in `(fromHeight, toHeight]`, so a
    ///      proof is only trusted for the values at those heights, never for which heights they are.
    function _checkBoundaries(uint64 fromHeight, uint64 toHeight, uint64[] memory heights, uint256 valueCount)
        internal
        view
    {
        uint256 before = _boundariesUpTo(fromHeight);
        uint256 n = _boundariesUpTo(toHeight) - before;
        if (heights.length != n || valueCount != n) revert BadCheckpoints();
        for (uint256 i = 0; i < n; ++i) {
            if (heights[i] != GENESIS_HEIGHT - 1 + (before + 1 + i) * CHECKPOINT_INTERVAL) revert BadCheckpoints();
        }
    }

    /// @dev Mirrors RelayerRewards' token rule, so a stored list can never make `finalize` or `reject` revert.
    function _checkTokens(address[] calldata tokens) internal pure {
        if (tokens.length > 8) revert BadTokens();
        address previous;
        for (uint256 i = 0; i < tokens.length; ++i) {
            if (tokens[i] <= previous) revert BadTokens();
            previous = tokens[i];
        }
    }

    /// @dev Series boundaries are the heights `GENESIS_HEIGHT − 1 + m·CHECKPOINT_INTERVAL`, m ≥ 1 (the guest's rule).
    function _isBoundary(uint64 height) internal view returns (bool) {
        return height >= GENESIS_HEIGHT && (height + 1 - GENESIS_HEIGHT) % CHECKPOINT_INTERVAL == 0;
    }

    function _boundariesUpTo(uint64 height) internal view returns (uint256) {
        return height + 1 < GENESIS_HEIGHT ? 0 : (height + 1 - GENESIS_HEIGHT) / CHECKPOINT_INTERVAL;
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
