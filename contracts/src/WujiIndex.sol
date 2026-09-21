// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {RelayerRewards} from "./RelayerRewards.sol";
import {BitcoinRelay} from "./BitcoinRelay.sol";
/// @notice Fold six-deep Bitcoin headers. R = SHA256(raw SHA256d(header)) in digest order, not explorer order.
contract WujiIndex {
    int256 public constant UNIT = 1.2e13;
    int256 public constant MEAN = 4080;
    uint64 public constant CONFIRMATIONS = 6;
    uint256 public constant DEFAULT_MAX = 256;
    // Bounds the advertised tip's age, not proof that no higher-work Bitcoin tip exists elsewhere.
    uint256 public constant MAX_RELAY_AGE = 3 hours;
    // Testnet candidate: a branch-observation delay, not a proven mining-cost/security threshold.
    uint64 public constant FROZEN_EXIT_DELAY = 144;
    BitcoinRelay public immutable relay;
    RelayerRewards public immutable rewards;
    uint64 public immutable GENESIS_HEIGHT;
    uint64 public immutable CHECKPOINT_INTERVAL;
    int256 public S;
    uint64 public lastHeight;
    bytes32 public lastHash;
    uint64 public nextCheckpointHeight;
    mapping(uint64 => int256) public checkpointS;
    mapping(uint64 => bool) public checkpointed;
    struct ReorgNotice {
        uint64 fromHeight;
        uint64 readyHeight;
        uint64 foldedHeight;
        bytes32 foldedHash;
        bytes32 tipHash;
        uint256 revision;
    }
    ReorgNotice public reorgNotice;
    bool public frozen;
    event Fold(uint64 indexed fromHeight, uint64 indexed toHeight, int256 S);
    event Checkpoint(uint64 indexed height, int256 S);
    event ReorgObserved(uint64 indexed fromHeight, uint64 readyHeight, bytes32 tipHash, uint256 revision);
    event Frozen(uint64 indexed foldedHeight, bytes32 foldedHash, int256 S, uint64 relayHeight);
    constructor(BitcoinRelay relay_, uint64 genesis, uint64 interval, RelayerRewards rewards_) {
        if (address(rewards_) != address(0)) {
            require(rewards_.index() == address(this) && rewards_.GENESIS_HEIGHT() == genesis, "reward index mismatch");
        }
        rewards = rewards_;
        require(address(relay_).code.length > 0, "relay not contract");
        require(genesis > 0 && genesis >= relay_.checkpointHeight(), "genesis before checkpoint");
        require(interval > 0 && genesis <= type(uint64).max - interval, "checkpoint interval");
        relay = relay_; GENESIS_HEIGHT = genesis; CHECKPOINT_INTERVAL = interval;
        lastHeight = genesis - 1; nextCheckpointHeight = genesis + interval - 1;
    }
    function finalizedHeight() public view returns (uint64) {
        uint64 best = relay.bestHeight(); return best > CONFIRMATIONS ? best - CONFIRMATIONS : 0;
    }
    function pending() public view returns (uint256) {
        uint64 f = finalizedHeight(); return f > lastHeight ? f - lastHeight : 0;
    }
    function relayFresh() public view returns (bool) {
        uint256 time = relay.timestampOf(relay.bestHash());
        return block.timestamp <= time + MAX_RELAY_AGE && time <= block.timestamp + 2 hours;
    }
    function historyConsistent() public view returns (bool) {
        return lastHash == bytes32(0) || relay.headerAt(lastHeight) == lastHash;
    }
    /// @notice Record a proven folded-history mismatch. Repeating a valid notice cannot postpone its deadline.
    /// @dev A reverted fold cannot persist this state; observation must be a separate successful call.
    function observeReorg() external returns (uint64 readyHeight) {
        require(!frozen, "index frozen");
        require(!historyConsistent(), "history consistent");
        if (_noticeValid()) return reorgNotice.readyHeight;
        uint64 height = relay.bestHeight();
        uint64 base = height > lastHeight ? height : lastHeight;
        readyHeight = base + FROZEN_EXIT_DELAY;
        bytes32 tip = relay.bestHash();
        uint256 revision = relay.reorgCount();
        reorgNotice = ReorgNotice(height, readyHeight, lastHeight, lastHash, tip, revision);
        emit ReorgObserved(height, readyHeight, tip, revision);
    }
    function _noticeValid() internal view returns (bool) {
        ReorgNotice memory n = reorgNotice;
        return n.fromHeight != 0 && n.foldedHeight == lastHeight && n.foldedHash == lastHash
            && !historyConsistent() && n.revision == relay.reorgCount()
            && relay.headerAt(n.fromHeight) == n.tipHash;
    }
    function frozenExitReady() public view returns (bool) {
        return !frozen && _noticeValid() && relay.bestHeight() >= reorgNotice.readyHeight;
    }
    /// @notice Irreversibly seal this index; all vaults may then close using already recorded boundaries.
    /// @dev No wall-clock/staleness shortcut, caller-selected value or new reward allocation.
    function freeze() external {
        require(!frozen, "index frozen");
        require(frozenExitReady(), "frozen exit not ready");
        frozen = true;
        emit Frozen(lastHeight, lastHash, S, relay.bestHeight());
    }
    function fold() external returns (uint64) { return fold(DEFAULT_MAX); }
    /// @notice Atomically relay and fold so the transaction completing both can earn the bounty.
    /// @dev Standalone submit/fold remain available, including when a deep reorg prevents folding.
    function submitAndFold(bytes calldata headers, uint256 max, address[] memory rewardTokens) external returns (uint64) {
        relay.submit(headers);
        return fold(max, rewardTokens);
    }
    /// @notice Fold without a bounty. These heights cannot earn rewards retroactively.
    function fold(uint256 max) public returns (uint64) { return fold(max, new address[](0)); }
    /// @notice Fold and allocate one-off bounties in a sorted, unique list of at most eight tokens.
    function fold(uint256 max, address[] memory rewardTokens) public returns (uint64) {
        require(rewardTokens.length == 0 || address(rewards) != address(0), "rewards disabled");
        require(rewardTokens.length <= 8, "token limit");
        require(rewardTokens.length == 0 || max <= DEFAULT_MAX, "height limit");
        require(!frozen, "index frozen");
        require(historyConsistent(), "deep Bitcoin reorg");
        uint256 count = pending();
        // Empty deployments can create their vaults before catch-up. A stale nonempty backlog cannot advance.
        if(count>0) require(relayFresh(), "relay stale");
        if (count > max) count = max;
        if (count == 0) return 0;
        uint64 from = lastHeight + 1; uint64 to = lastHeight + uint64(count);
        int256 value = S;
        for (uint64 h = from; h <= to; h++) {
            bytes32 hash = relay.headerAt(h); require(hash != bytes32(0), "header unavailable");
            value += increment(sha256(abi.encodePacked(hash)));
            if (h == nextCheckpointHeight) {
                checkpointS[h] = value; checkpointed[h] = true; emit Checkpoint(h, value);
                nextCheckpointHeight = h + CHECKPOINT_INTERVAL;
            }
            lastHash = hash;
        }
        lastHeight = to; S = value;
        if (address(rewards) != address(0)) rewards.credit(msg.sender, from, to, rewardTokens); emit Fold(from, to, value); return uint64(count);
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


    function increment(bytes32 R) public pure returns (int256) { return (int256(byteSum(R)) - MEAN) * UNIT; }
}
