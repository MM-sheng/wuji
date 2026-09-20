// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {BitcoinRelay} from "../src/BitcoinRelay.sol";
import {MockBitcoinRelay} from "./mocks/MockBitcoinRelay.sol";
abstract contract WujiTestBase is Test {
    MockBitcoinRelay internal history;
    function installHistory() internal { history = new MockBitcoinRelay(); }
    function relay() internal view returns(BitcoinRelay) { return BitcoinRelay(address(history)); }
    function headerFor(uint64 h,uint256 salt) internal pure returns(bytes memory) { return abi.encodePacked(bytes32(uint256(h)),bytes32(salt),bytes16(0)); }
    function writeHashes(WujiIndex idx,uint64 from,uint64 to,uint256 salt) internal returns(int256 expected) {
        if(block.number<=to) vm.roll(to+1);
        for(uint64 h=from;h<=to;h++) {
            bytes memory header=headerFor(h,salt); history.submit(h,header);
            expected+=idx.increment(sha256(abi.encodePacked(sha256(abi.encodePacked(sha256(header))))));
        }
    }
}
