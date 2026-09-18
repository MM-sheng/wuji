// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WujiIndex} from "../src/WujiIndex.sol";

contract WujiIndexTest is Test {
    WujiIndex idx;
    uint64 constant GENESIS = 1000;

    function setUp() public {
        vm.roll(GENESIS);
        idx = new WujiIndex(GENESIS);
    }

    // ---------- byteSum / increment ----------

    function naiveByteSum(bytes32 h) internal pure returns (uint256 s) {
        for (uint256 i = 0; i < 32; i++) s += uint8(h[i]);
    }

    function testFuzz_byteSumMatchesNaive(bytes32 h) public view {
        assertEq(idx.byteSum(h), naiveByteSum(h));
    }

    function test_byteSumBounds() public view {
        assertEq(idx.byteSum(bytes32(0)), 0);
        assertEq(idx.byteSum(bytes32(type(uint256).max)), 32 * 255);
        assertEq(idx.increment(bytes32(0)), -4080 * idx.UNIT());
        assertEq(idx.increment(bytes32(type(uint256).max)), (8160 - 4080) * idx.UNIT());
    }

    function test_incrementKnownHash() public view {
        // BSC block 122616100 — cross-checked against indexer/index.mjs (byteSum = 4311)
        bytes32 h = 0x2afdf0fbb1c49b4cb4852cad483c80283302fc05ee968a64c8ecb57c44738b5c;
        assertEq(idx.byteSum(h), 4311);
        assertEq(idx.increment(h), (4311 - 4080) * int256(3.3e11));
    }

    // ---------- tick ----------

    function setHashes(uint64 from, uint64 to, uint256 salt) internal returns (int256 expected) {
        if (block.number <= to) vm.roll(to + 1); // hashes can only be set for past blocks
        for (uint64 b = from; b <= to; b++) {
            bytes32 h = keccak256(abi.encode(b, salt));
            vm.setBlockhash(b, h);
            expected += idx.increment(h);
        }
    }

    function test_nothingToFoldAtGenesis() public {
        assertEq(idx.tick(), 0);
        assertEq(idx.S(), 0);
        assertEq(idx.lastBlock(), GENESIS - 1);
    }

    function test_tickFoldsEveryBlockOnce() public {
        int256 exp1 = setHashes(GENESIS, GENESIS + 9, 1);
        vm.roll(GENESIS + 10);
        assertEq(idx.tick(), 10);
        assertEq(idx.S(), exp1);
        assertEq(idx.lastBlock(), GENESIS + 9);
        assertEq(idx.pending(), 0);
        // same block again: nothing new
        assertEq(idx.tick(), 0);
        assertEq(idx.S(), exp1);
        // ten more
        int256 exp2 = setHashes(GENESIS + 10, GENESIS + 19, 2);
        vm.roll(GENESIS + 20);
        assertEq(idx.tick(), 10);
        assertEq(idx.S(), exp1 + exp2);
    }

    function test_splittingTicksDoesNotChangeS() public {
        int256 expAll = setHashes(GENESIS, GENESIS + 99, 7);
        // path A: one tick
        vm.roll(GENESIS + 100);
        idx.tick();
        int256 sA = idx.S();
        assertEq(sA, expAll);
        // path B: fresh index, many small ticks over the same hashes
        vm.roll(GENESIS);
        WujiIndex idx2 = new WujiIndex(GENESIS);
        for (uint64 b = GENESIS + 1; b <= GENESIS + 100; b += 7) {
            vm.roll(b);
            idx2.tick();
        }
        vm.roll(GENESIS + 100);
        idx2.tick();
        assertEq(idx2.S(), sA);
        assertEq(idx2.frozenBlocks(), 0);
    }

    function test_gapFreezesUnreachableBlocks() public {
        // nobody ticks for 400 blocks: only the last 256 reachable ones fold, 144 freeze
        setHashes(GENESIS, GENESIS + 399, 3);
        vm.roll(GENESIS + 400);
        uint64 oldest = GENESIS + 400 - 256;
        int256 expected;
        for (uint64 b = oldest; b <= GENESIS + 399; b++) expected += idx.increment(blockhash(b));

        vm.expectEmit(true, true, false, false);
        emit WujiIndex.Gap(GENESIS, oldest - 1);
        assertEq(idx.tick(), 256);
        assertEq(idx.S(), expected);
        assertEq(idx.frozenBlocks(), oldest - GENESIS);
        assertEq(idx.lastBlock(), GENESIS + 399);
    }

    function test_maxReachIsExactly256() public {
        setHashes(GENESIS, GENESIS + 255, 4);
        vm.roll(GENESIS + 256);
        assertEq(idx.tick(), 256);
        assertEq(idx.frozenBlocks(), 0);
        // one block later than that and the oldest one freezes
        vm.roll(GENESIS);
        WujiIndex idx2 = new WujiIndex(GENESIS);
        vm.roll(GENESIS + 257);
        assertEq(idx2.tick(), 256);
        assertEq(idx2.frozenBlocks(), 1);
    }

    function test_constructorRejectsUnreachableGenesis() public {
        vm.roll(5000);
        vm.expectRevert("genesis out of reach");
        new WujiIndex(5000 - 256);
        new WujiIndex(5000 - 255); // boundary ok
        new WujiIndex(6000);       // future ok
    }

    function test_gasPerFullTick() public {
        setHashes(GENESIS, GENESIS + 254, 9);
        vm.roll(GENESIS + 255);
        uint256 g = gasleft();
        idx.tick();
        uint256 used = g - gasleft();
        emit log_named_uint("gas for a 255-block tick", used);
        assertLt(used, 600_000);
    }
}
