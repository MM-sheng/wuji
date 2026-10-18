// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WujiHeaderIndexReorgTest, EasyHeaderIndex} from "./WujiHeaderIndex.reorg.t.sol";
import {WujiHeaderIndexTest} from "./WujiHeaderIndex.t.sol";
import {WujiHeaderIndex} from "../src/WujiHeaderIndex.sol";

/// The inherited fixtures lower PoW difficulty only. Select test_segment* to run just these regressions.
contract WujiHeaderIndexSegmentsTest is WujiHeaderIndexReorgTest {
    event ReorgProgress(bytes32 indexed commitment, bytes proof);
    function _slice(bytes memory data, uint256 start, uint256 count) internal pure returns (bytes memory out) {
        out = new bytes(count * 80);
        for (uint256 i; i < out.length; ++i) out[i] = data[start * 80 + i];
    }

    function test_segment801HeadersRecoverTheFormerUnsealableReorg() public {
        idx = new EasyHeaderIndex(anchorHeader, ANCHOR, anchorTimes, 100);
        bytes memory base = _base();
        bytes memory main = _chain(anchorHeader, ANCHOR + 1, 657, 1_000_000);
        idx.foldHeaders(_slice(main, 0, 350), new address[](0));
        idx.foldHeaders(_slice(main, 250, 350), new address[](0));
        idx.foldHeaders(_slice(main, 500, 157), new address[](0));
        bytes memory before = _base();
        bytes memory branch = _chain(anchorHeader, ANCHOR + 1, 801, 7_000_000);
        bytes memory first800 = _slice(branch, 0, 800);
        vm.expectRevert(WujiHeaderIndex.NoReorg.selector);
        idx.freezeOnReorg(base, first800);
        vm.expectRevert(WujiHeaderIndex.TooManyHeaders.selector);
        idx.freezeOnReorg(base, branch);

        bytes memory proof = idx.beginReorg(base, _slice(branch, 0, 256));
        proof = idx.extendReorg(proof, _slice(branch, 256, 256));
        proof = idx.extendReorg(proof, _slice(branch, 512, 256));
        proof = idx.extendReorg(proof, _slice(branch, 768, 32));
        vm.expectRevert(WujiHeaderIndex.NoReorg.selector);
        idx.freezeReorg(proof);
        proof = idx.extendReorg(proof, _slice(branch, 800, 1));
        assertEq(_base(), before, "candidates cannot change the index");
        vm.prank(address(0xCAFE));
        idx.freezeReorg(proof);
        assertTrue(idx.frozen());
        assertEq(_base(), before, "sealing preserves consumer state");
        assertEq(idx.seenHeight(), ANCHOR + 657);
    }

    function test_segmentSurvivesTipAdvanceButUsesTheNewWorkThreshold() public {
        bytes memory base = _base();
        bytes memory main = _foldMain();
        bytes memory branch = _chain(anchorHeader, ANCHOR + 1, 214, 7_000_000);
        bytes memory proof = idx.beginReorg(base, _slice(branch, 0, 20));
        // The target of this candidate was ANCHOR+54, but the finalized chain advances another ten blocks.
        idx.foldHeaders(bytes.concat(_slice(main, 54, 6), _chain(_last(main), ANCHOR + 61, 10, 1_500_000)), new address[](0));
        assertEq(idx.lastHeight(), ANCHOR + 64);
        proof = idx.extendReorg(proof, _slice(branch, 20, 184));
        vm.expectRevert(WujiHeaderIndex.NoReorg.selector);
        idx.freezeReorg(proof); // 204 headers met the OLD threshold only.
        proof = idx.extendReorg(proof, _slice(branch, 204, 10));
        idx.freezeReorg(proof);
        assertTrue(idx.frozen());
    }

    function test_segmentMainChainNeverBecomesAReorgEvenAfterTipAdvance() public {
        bytes memory base = _base();
        bytes memory main = _foldMain();
        bytes memory proof = idx.beginReorg(base, _slice(main, 0, 20));
        idx.foldHeaders(bytes.concat(_slice(main, 54, 6), _chain(_last(main), ANCHOR + 61, 10, 1_500_000)), new address[](0));
        bytes memory crossing = _slice(main, 20, 34);
        vm.expectRevert(WujiHeaderIndex.NoReorg.selector);
        idx.extendReorg(proof, crossing); // Must still check the original target at 54, not only the new tip.
        vm.expectRevert(WujiHeaderIndex.NoReorg.selector);
        idx.freezeReorg(proof);
    }

    function test_segmentEveryEncodedFieldIsAuthenticated() public {
        bytes memory base = _base();
        _foldMain();
        bytes memory branch = _chain(anchorHeader, ANCHOR + 1, 205, 7_000_000);
        bytes memory proof = idx.beginReorg(base, _slice(branch, 0, 204));
        bytes memory next = _slice(branch, 204, 1);
        assertEq(proof.length, 21 * 32);
        for (uint256 i; i < 21; ++i) {
            uint256 at = i * 32 + 31;
            proof[at] = bytes1(uint8(proof[at]) ^ 1);
            assertFalse(idx.isReorgProof(proof));
            vm.expectRevert(WujiHeaderIndex.Discontinuous.selector);
            idx.extendReorg(proof, next);
            vm.expectRevert(WujiHeaderIndex.Discontinuous.selector);
            idx.freezeReorg(proof);
            proof[at] = bytes1(uint8(proof[at]) ^ 1);
        }
        assertTrue(idx.isReorgProof(proof));
        idx.freezeReorg(proof);
    }

    function test_segmentCandidatesAndSubmittersCannotInvalidateEachOther() public {
        bytes memory base = _base();
        _foldMain();
        bytes memory a = _chain(anchorHeader, ANCHOR + 1, 204, 7_000_000);
        bytes memory b = _chain(anchorHeader, ANCHOR + 1, 204, 8_000_000);
        bytes memory a0 = _slice(a, 0, 100);
        bytes memory pa = idx.beginReorg(base, a0);
        vm.expectEmit(true, false, false, true, address(idx));
        emit ReorgProgress(keccak256(pa), pa);
        vm.prank(address(0xBAD));
        assertEq(idx.beginReorg(base, a0), pa, "replay/front-run is idempotent");
        bytes memory pb = idx.beginReorg(base, _slice(b, 0, 100));
        bytes memory b1 = _slice(b, 100, 104);
        vm.expectRevert(WujiHeaderIndex.Linkage.selector);
        idx.extendReorg(pa, b1);
        pb = idx.extendReorg(pb, b1);
        bytes memory a1 = _slice(a, 100, 104);
        vm.prank(address(0xCAFE));
        pa = idx.extendReorg(pa, a1);
        assertTrue(idx.isReorgProof(pb));
        assertTrue(idx.isReorgProof(pa));
        vm.prank(address(0xBEEF));
        idx.freezeReorg(pa);
    }

    function test_segmentBoundsBaseValidationAndFrozenGuards() public {
        bytes memory base = _base();
        _foldMain();
        bytes memory branch = _chain(anchorHeader, ANCHOR + 1, 257, 7_000_000);
        bytes memory first = _slice(branch, 0, 204);
        vm.expectRevert(WujiHeaderIndex.BadLength.selector);
        idx.beginReorg(base, "");
        vm.expectRevert(WujiHeaderIndex.BadLength.selector);
        idx.beginReorg(base, new bytes(79));
        vm.expectRevert(WujiHeaderIndex.TooManyHeaders.selector);
        idx.beginReorg(base, branch);
        base[31] = bytes1(uint8(base[31]) ^ 1);
        vm.expectRevert(WujiHeaderIndex.Discontinuous.selector);
        idx.beginReorg(base, first);
        base[31] = bytes1(uint8(base[31]) ^ 1);
        bytes memory tipBase = _base();
        vm.expectRevert(WujiHeaderIndex.NoReorg.selector);
        idx.beginReorg(tipBase, first);
        bytes memory proof = idx.beginReorg(base, first);
        vm.expectRevert(WujiHeaderIndex.TooManyHeaders.selector);
        idx.extendReorg(proof, branch);
        vm.expectRevert(WujiHeaderIndex.BadLength.selector);
        idx.extendReorg(proof, "");
        idx.freezeReorg(proof);
        vm.expectRevert(WujiHeaderIndex.IndexFrozen.selector);
        idx.beginReorg(base, first);
        vm.expectRevert(WujiHeaderIndex.IndexFrozen.selector);
        idx.extendReorg(proof, first);
        vm.expectRevert(WujiHeaderIndex.IndexFrozen.selector);
        idx.freezeReorg(proof);
    }

    function test_segmentAndOneShotSealPreserveIdenticalFinalState() public {
        bytes memory base = _base();
        _foldMain();
        bytes memory branch = _chain(anchorHeader, ANCHOR + 1, 204, 7_000_000);
        uint256 snapshot = vm.snapshotState();
        idx.freezeOnReorg(base, branch);
        bytes memory expected = _base();
        assertTrue(vm.revertToState(snapshot));
        bytes memory proof = idx.beginReorg(base, _slice(branch, 0, 73));
        proof = idx.extendReorg(proof, _slice(branch, 73, 131));
        idx.freezeReorg(proof);
        assertTrue(idx.frozen());
        assertEq(_base(), expected);
    }

    function testFuzz_segmentPartitionDoesNotChangeTheAuthenticatedState(uint8 split) public {
        bytes memory base = _base();
        _foldMain();
        bytes memory branch = _chain(anchorHeader, ANCHOR + 1, 204, 7_000_000);
        bytes memory full = idx.beginReorg(base, branch);
        uint256 n = uint256(split) % 203 + 1;
        bytes memory segmented = idx.beginReorg(base, _slice(branch, 0, n));
        segmented = idx.extendReorg(segmented, _slice(branch, n, 204 - n));
        assertEq(segmented, full);
        idx.freezeReorg(segmented);
        assertTrue(idx.frozen());
    }

    function test_segmentMtpChronologyIsCarriedAcrossCalls() public {
        (EasyHeaderIndex local, bytes memory a) = _nonMonotoneIndex();
        (WujiHeaderIndex.Continuity memory state, uint32[11] memory times, uint256 work) = local.continuity();
        bytes memory base = abi.encode(state, times, work);
        bytes memory main = _mine(_hash(a), T0 + 20, 101);
        local.foldHeaders(bytes.concat(main, _mine(_hash(main), T0 + 21, 102)), new address[](0));
        bytes memory b = _mine(_hash(a), T0 + 12, 91);
        bytes memory proof = local.beginReorg(base, b);
        bytes memory equalMedian = _mine(_hash(b), T0 + 6, 92);
        vm.expectRevert(WujiHeaderIndex.MedianTimePast.selector);
        local.extendReorg(proof, equalMedian);
        bytes memory c = _mine(_hash(b), T0 + 7, 92);
        proof = local.extendReorg(proof, c);
        WujiHeaderIndex.ReorgProof memory decoded = abi.decode(proof, (WujiHeaderIndex.ReorgProof));
        assertEq(decoded.times[9], T0 + 12);
        assertEq(decoded.times[10], T0 + 7);
        assertEq(decoded.times[0], T0 + 2);
    }

    function test_segmentRejectsDifficultyFutureTimeAndInvalidPow() public {
        bytes memory base = _base();
        _foldMain();
        bytes memory first = _chain(anchorHeader, ANCHOR + 1, 1, 7_000_000);
        bytes memory proof = idx.beginReorg(base, first);
        bytes memory next = _chain(first, ANCHOR + 2, 1, 7_000_001);
        next[72] = bytes1(uint8(next[72]) ^ 1);
        vm.expectRevert(WujiHeaderIndex.Difficulty.selector);
        idx.extendReorg(proof, next);
        next[72] = bytes1(uint8(next[72]) ^ 1);
        while (uint256(_reverse(_hash(next))) <= _target()) next[36] = bytes1(uint8(next[36]) + 1);
        vm.expectRevert(WujiHeaderIndex.BadWork.selector);
        idx.extendReorg(proof, next);
        bytes memory future = _mine(_hash(first), uint32(block.timestamp + 2 hours + 1), 7_000_002);
        vm.expectRevert(WujiHeaderIndex.FutureTime.selector);
        idx.extendReorg(proof, future);
    }
}

/// Real Bitcoin headers exercise production PoW, retarget and MTP rules as well as the per-segment gas bound.
contract WujiHeaderIndexRealSegmentsTest is WujiHeaderIndexTest {
    function test_segmentRealRetargetAndFullContinuationMatchNormalReplay() public {
        (WujiHeaderIndex.Continuity memory c, uint32[11] memory t, uint256 w) = idx.continuity();
        bytes memory base = abi.encode(c, t, w);
        idx.foldHeaders(_slice(0, 500), new address[](0));
        idx.foldHeaders(_slice(494, 112), new address[](0)); // finalized 600, beyond these proof segments
        bytes memory segment = _slice(0, 256); // includes a real difficulty retarget at the first header
        uint256 gasBefore = gasleft();
        bytes memory proof = idx.beginReorg(base, segment);
        uint256 used = gasBefore - gasleft();
        assertLt(used, 8_000_000, "bounded 256-header production segment");
        emit log_named_uint("256-header segment execution gas", used);
        WujiHeaderIndex.ReorgProof memory p = abi.decode(proof, (WujiHeaderIndex.ReorgProof));
        WujiHeaderIndex mirror = _deploy(6, 4320);
        mirror.foldHeaders(_slice(0, 262), new address[](0));
        (c, t, w) = mirror.continuity();
        assertEq(abi.encode(p.branch, p.times, p.work), abi.encode(c, t, w));
        // Segment partitioning changes neither the committed continuation nor its timestamps/work.
        bytes memory split = idx.beginReorg(base, _slice(0, 17));
        split = idx.extendReorg(split, _slice(17, 239));
        assertEq(split, proof);
        proof = idx.extendReorg(proof, _slice(256, 256));
        p = abi.decode(proof, (WujiHeaderIndex.ReorgProof));
        assertEq(p.branch.height, anchorHeight + 512);
        vm.expectRevert(WujiHeaderIndex.NoReorg.selector);
        idx.freezeReorg(proof); // authentic common-prefix progress is not evidence of a reorg
    }
}
