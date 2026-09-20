// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {WujiIndex} from "../src/WujiIndex.sol";
import {WujiTestBase} from "./Base.t.sol";
contract WujiIndexTest is WujiTestBase {
    WujiIndex idx;
    function setUp() public { installHistory(); idx=new WujiIndex(relay(),1000,10); }
    function testFuzz_byteSumMatchesNaive(bytes32 h) public view {
        uint256 sum; for(uint256 i;i<32;i++) sum+=uint8(h[i]); assertEq(idx.byteSum(h),sum);
    }
    function test_byteSumBounds() public view {
        assertEq(idx.increment(0),-4080*idx.UNIT());
        assertEq(idx.increment(bytes32(type(uint256).max)),4080*idx.UNIT());
    }
    function test_sixConfirmationsAndNoDoubleFold() public {
        int256 expected=writeHashes(idx,1000,1009,1);
        history.setBest(1009); assertEq(idx.fold(),4); assertEq(idx.lastHeight(),1003);
        history.setBest(1015); assertEq(idx.fold(),6); assertEq(idx.S(),expected);
        assertTrue(idx.checkpointed(1009)); assertEq(idx.checkpointS(1009),expected); assertEq(idx.fold(),0);
    }
    function test_boundedAndDelayedFoldIsSamePath() public {
        int256 expected=writeHashes(idx,1000,1299,8);
        assertEq(idx.fold(),256); assertEq(idx.fold(),44); assertEq(idx.S(),expected);
        WujiIndex other=new WujiIndex(relay(),1000,10); other.fold(300); assertEq(other.S(),idx.S());
    }
    function test_futureGenesis() public { WujiIndex other=new WujiIndex(relay(),10000,4320); assertEq(other.pending(),0); assertEq(other.fold(),0); }
    function test_deepReorgEvenOnNoopMustRevert() public {
        writeHashes(idx,1000,1009,1); idx.fold(); history.replace(1009,bytes32(uint256(1)));
        vm.expectRevert("deep Bitcoin reorg");idx.fold(0);
        vm.expectRevert("deep Bitcoin reorg");idx.fold();
    }
    function test_shallowReorgOnlyChangesUnfoldedPath() public {
        writeHashes(idx,1000,1009,1); history.setBest(1009); idx.fold();
        int256 before=idx.S(); int256 afterPart=writeHashes(idx,1004,1009,2); idx.fold(); assertEq(idx.S(),before+afterPart);
    }
    function test_constructorBounds() public {
        vm.expectRevert("genesis before checkpoint");new WujiIndex(relay(),998,10);
        vm.expectRevert("checkpoint interval");new WujiIndex(relay(),1000,0);
    }
}
