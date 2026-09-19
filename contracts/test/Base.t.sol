// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {MockHistory} from "./mocks/MockHistory.sol";

/// Shared plumbing: installs a mock EIP-2935 history contract at the canonical address and writes
/// fake block hashes both to the EVM (blockhash) and to the mock (history) so every reach path works.
abstract contract WujiTestBase is Test {
    MockHistory internal history;

    function installHistory() internal {
        history = new MockHistory();
        vm.etch(0x0000F90827F1C53a10cb7A02335B175320002935, address(history).code);
        history = MockHistory(payable(0x0000F90827F1C53a10cb7A02335B175320002935));
    }

    function hashFor(uint64 b, uint256 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(b, salt));
    }

    /// Write hashes for blocks [from, to] and roll to to+1. Returns Σ increment for an index `idx`.
    function writeHashes(WujiIndex idx, uint64 from, uint64 to, uint256 salt) internal returns (int256 expected) {
        if (block.number <= to) vm.roll(to + 1);
        for (uint64 b = from; b <= to; b++) {
            bytes32 h = hashFor(b, salt);
            vm.setBlockhash(b, h);
            history.set(b, h);
            expected += idx.increment(h);
        }
    }

    function writeConstant(WujiIndex idx, uint64 from, uint64 to, bytes32 h) internal returns (int256 expected) {
        if (block.number <= to) vm.roll(to + 1);
        for (uint64 b = from; b <= to; b++) { vm.setBlockhash(b, h); history.set(b, h); }
        expected = int256(uint256(to - from + 1)) * idx.increment(h);
    }
}
