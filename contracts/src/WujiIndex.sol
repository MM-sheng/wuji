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
    event Fold(uint64 indexed fromHeight, uint64 indexed toHeight, int256 S);
    event Checkpoint(uint64 indexed height, int256 S);
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
        require(lastHash == bytes32(0) || relay.headerAt(lastHeight) == lastHash, "deep Bitcoin reorg");
        uint256 count = pending(); if (count > max) count = max;
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
