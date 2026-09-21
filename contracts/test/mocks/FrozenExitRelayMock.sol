// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test-only branch state feeder. No PoW, linkage or work validation; those have separate relay tests.
contract FrozenExitRelayMock {
    uint64 public constant checkpointHeight = 999;
    uint64 public bestHeight = 999;
    bytes32 public bestHash = keccak256("checkpoint");
    uint256 public reorgCount;
    bool public stale;
    mapping(uint64 => bytes32) private headers;

    constructor() {
        headers[999] = bestHash;
    }

    function headerAt(uint64 h) external view returns (bytes32) {
        return h > bestHeight ? bytes32(0) : headers[h];
    }

    function timestampOf(bytes32) external view returns (uint32) {
        return uint32(stale ? block.timestamp - 4 hours : block.timestamp);
    }

    function setStale(bool value) external {
        stale = value;
    }

    function put(uint64 h, bytes32 hash) external {
        headers[h] = hash;
    }

    function tip(uint64 h, bytes32 hash, bool fork) external {
        headers[h] = hash;
        bestHeight = h;
        bestHash = hash;
        if (fork) ++reorgCount;
    }
}
