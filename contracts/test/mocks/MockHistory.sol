// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Stand-in for the EIP-2935 history contract: serves hashes for the last `WINDOW` blocks, reverts otherwise.
contract MockHistory {
    uint256 constant WINDOW = 8191;
    mapping(uint256 => bytes32) public hashes;

    function set(uint256 b, bytes32 h) external { hashes[b] = h; }

    fallback(bytes calldata data) external returns (bytes memory) {
        require(data.length == 32, "bad input");
        uint256 b = abi.decode(data, (uint256));
        require(b < block.number && block.number - b <= WINDOW, "out of window");
        bytes32 h = hashes[b];
        require(h != bytes32(0), "unset");
        return abi.encode(h);
    }
}
