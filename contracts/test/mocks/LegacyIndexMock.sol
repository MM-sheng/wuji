// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {WujiIndex} from "../../src/WujiIndex.sol";
import {BitcoinRelay} from "../../src/BitcoinRelay.sol";

/// @dev An index without the T9 frozen exit (like BSC testnet v3): no frozen(), no historyConsistent().
contract LegacyIndexMock {
    WujiIndex public immutable inner;
    constructor(WujiIndex inner_) { inner = inner_; }
    function S() external view returns (int256) { return inner.S(); }
    function lastHeight() external view returns (uint64) { return inner.lastHeight(); }
    function lastHash() external view returns (bytes32) { return inner.lastHash(); }
    function relay() external view returns (BitcoinRelay) { return inner.relay(); }
    function relayFresh() external view returns (bool) { return inner.relayFresh(); }
}
