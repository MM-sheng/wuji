// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WujiIndex} from "../src/WujiIndex.sol";
import {WujiTestBase} from "./Base.t.sol";

contract WujiIndexTest is WujiTestBase {
    WujiIndex idx;
    uint64 constant GENESIS = 1000;

    function setUp() public {
        installHistory();
        vm.roll(GENESIS);
        idx = new WujiIndex(GENESIS);
    }

    // ---------- byteSum / increment ----------

    function naiveByteSum(bytes32 h) internal pure returns (uint256 s) {
        for (uint256 i = 0; i < 32; i++) {
            s += uint8(h[i]);
        }
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
        return writeHashes(idx, from, to, salt);
    }

    function test_nothingToFoldAtGenesis() public {
        assertEq(idx.tick(), 0);
        assertEq(idx.S(), 0);
        assertEq(idx.lastBlock(), GENESIS - 1);
    }

    function test_futureGenesisReportsNoPendingBlocks() public {
        WujiIndex future = new WujiIndex(GENESIS + 1000);
        assertEq(future.pending(), 0);
        assertEq(future.tick(), 0);
    }

    function test_futureGenesisAtBlockZeroReportsNoPendingBlocks() public {
        vm.roll(0);
        WujiIndex future = new WujiIndex(1);
        assertEq(future.pending(), 0);
        assertEq(future.tick(), 0);
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

    function test_gapFreezesBlocksBeyondHistoryWindow() public {
        // nobody ticks for 10000 blocks: the last 8191 reachable ones fold (in chunks), 1809 freeze
        setHashes(GENESIS, GENESIS + 9999, 3);
        vm.roll(GENESIS + 10000);
        uint64 oldest = GENESIS + 10000 - 8191;
        int256 expected;
        for (uint64 b = oldest; b <= GENESIS + 9999; b++) {
            expected += idx.increment(hashFor(b, 3));
        }

        vm.expectEmit(true, true, false, false);
        emit WujiIndex.Gap(GENESIS, oldest - 1);
        uint64 total = idx.tick(10000);
        assertEq(total, 8191);
        assertEq(idx.S(), expected);
        assertEq(idx.frozenBlocks(), oldest - GENESIS);
        assertEq(idx.lastBlock(), GENESIS + 9999);
    }

    function test_defaultTickIsCappedAndResumable() public {
        int256 expected = setHashes(GENESIS, GENESIS + 2999, 8);
        vm.roll(GENESIS + 3000);
        assertEq(idx.tick(), 1024); // DEFAULT_MAX
        assertEq(idx.lastBlock(), GENESIS + 1023);
        assertEq(idx.pending(), 3000 - 1024);
        assertEq(idx.tick(), 1024);
        assertEq(idx.tick(), 952);
        assertEq(idx.S(), expected);
        assertEq(idx.tick(), 0);
    }

    function test_historyPathUsedBeyond256() public {
        // fold 1000 blocks in one call: the first 744 must come from the history contract
        int256 expected = setHashes(GENESIS, GENESIS + 999, 11);
        vm.roll(GENESIS + 1000);
        assertEq(idx.tick(1000), 1000);
        assertEq(idx.S(), expected);
        assertEq(idx.frozenBlocks(), 0);
    }

    function test_revertsIfHistoryCannotServeInWindowBlock() public {
        // hashes set only in the EVM, not in the history mock → beyond 256 the fold must revert, not fabricate
        vm.roll(GENESIS + 600);
        for (uint64 b = GENESIS; b < GENESIS + 600; b++) {
            vm.setBlockhash(b, hashFor(b, 5));
        }
        vm.expectRevert("history unavailable");
        idx.tick(600);
        assertEq(idx.lastBlock(), GENESIS - 1); // nothing recorded
    }

    function test_maxReachIsExactlyHistoryWindow() public {
        setHashes(GENESIS, GENESIS + 8190, 4);
        vm.roll(GENESIS + 8191);
        assertEq(idx.tick(8191), 8191);
        assertEq(idx.frozenBlocks(), 0);
        // one block later than that and the oldest one freezes
        vm.roll(GENESIS);
        WujiIndex idx2 = new WujiIndex(GENESIS);
        vm.roll(GENESIS + 8192);
        assertEq(idx2.tick(8192), 8191);
        assertEq(idx2.frozenBlocks(), 1);
    }

    function test_constructorRejectsUnreachableGenesis() public {
        vm.roll(20000);
        vm.expectRevert("genesis out of reach");
        new WujiIndex(20000 - 8191);
        new WujiIndex(20000 - 8190); // boundary ok
        new WujiIndex(30000); // future ok
        vm.expectRevert("genesis out of reach");
        new WujiIndex(0);
    }

    function test_gasPerFullTick() public {
        setHashes(GENESIS, GENESIS + 2047, 9);
        vm.roll(GENESIS + 2048);
        uint256 g = gasleft();
        idx.tick(256);
        uint256 used = g - gasleft();
        emit log_named_uint("gas: 256 blocks via history", used);
        g = gasleft();
        idx.tick(2048);
        uint256 used2 = g - gasleft();
        emit log_named_uint("gas: remaining 1792 (1536 history + 256 blockhash)", used2);
        assertLt(used + used2, 12_000_000);
    }
}
