// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
/// Test-only header feeder. Does not validate PoW; production relay has separate real-header tests.
contract MockBitcoinRelay {
    // Economic fixtures intentionally model a fresh source; production timestamp rules have separate tests.
    function bestHash() external view returns(bytes32) { return headerAt[bestHeight]; }
    function timestampOf(bytes32) external view returns(uint32) { return uint32(block.timestamp); }
    uint64 public bestHeight = 999;
    uint64 public checkpointHeight = 999;
    mapping(uint64 => bytes32) public headerAt;
    function submit(uint64 height, bytes memory header) external {
        require(header.length == 80, "header length");
        headerAt[height] = sha256(abi.encodePacked(sha256(header)));
        if(height+6>bestHeight) bestHeight=height+6;
    }
    function setBest(uint64 height) external { bestHeight=height; }
    function replace(uint64 height,bytes32 hash) external { headerAt[height]=hash; }
}
