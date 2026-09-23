// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ZkWujiIndex, ISP1Verifier} from "../src/ZkWujiIndex.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";

/// Accepts any proof: the point of these tests is the state machine, not the proof system.
contract AcceptingVerifier is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

contract RejectingVerifier is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {
        revert("bad proof");
    }
}

contract ZkWujiIndexTest is Test {
    bytes headers;
    string meta;
    ZkWujiIndex idx;
    uint64 anchorHeight;
    uint64 genesis;

    function setUp() public {
        meta = vm.readFile("test/fixtures/bitcoin-timestamps.json");
        headers = vm.parseBytes(vm.readFile("test/fixtures/bitcoin-timestamps.hex"));
        anchorHeight = uint64(vm.parseJsonUint(meta, ".checkpointHeight"));
        genesis = uint64(vm.parseJsonUint(meta, ".start"));
        idx = _deploy(new AcceptingVerifier());
        vm.warp(1_800_000_000); // after every fixture timestamp, so the future-time bound never bites
    }

    function _deploy(ISP1Verifier verifier) internal returns (ZkWujiIndex) {
        bytes memory anchor = vm.parseBytes(string.concat("0x", vm.parseJsonString(meta, ".checkpointHeader")));
        bytes memory ancestors = vm.parseBytes(vm.readFile("test/fixtures/bitcoin-timestamps-ancestors.hex"));
        uint32[11] memory times;
        for (uint256 i = 0; i < 11; i++) {
            times[i] = _read32(ancestors, i * 80 + 68);
        }
        return new ZkWujiIndex(
            verifier,
            bytes32(uint256(1)),
            RelayerRewards(address(0)),
            anchor,
            anchorHeight,
            uint32(vm.parseJsonUint(meta, ".epochStartTime")),
            times,
            1e30,
            genesis,
            4320
        );
    }

    function _read32(bytes memory h, uint256 at) internal pure returns (uint32) {
        return uint32(uint8(h[at])) | uint32(uint8(h[at + 1])) << 8 | uint32(uint8(h[at + 2])) << 16
            | uint32(uint8(h[at + 3])) << 24;
    }

    function _slice(uint256 start, uint256 count) internal view returns (bytes memory out) {
        out = new bytes(count * 80);
        for (uint256 i = 0; i < count * 80; i++) {
            out[i] = headers[start * 80 + i];
        }
    }

    /// Independent expectation: sum the per-header increments directly, without going through fold().
    function _expectedU(uint256 count) internal view returns (int256 u) {
        for (uint256 i = 0; i < count; i++) {
            bytes32 hash = sha256(abi.encodePacked(sha256(_slice(i, 1))));
            u += int256(idx.byteSum(sha256(abi.encodePacked(hash)))) - 4080;
        }
    }

    // ---------------------------------------------------------------- escape hatch

    function test_foldHeadersStopsAtTheConfirmationDepth() public {
        uint256 batch = 60;
        idx.foldHeaders(_slice(0, batch), new address[](0));
        assertEq(idx.lastHeight(), genesis + batch - 1 - 6, "continuity must stop 6 below the validated tip");
        assertEq(idx.S(), _expectedU(batch - 6) * idx.UNIT(), "S is the accumulator at the folded height");
        // the snapshot is a copy, not an alias: the trailing 6 headers left no trace
        assertTrue(idx.lastHash() != sha256(abi.encodePacked(sha256(_slice(batch - 1, 1)))), "committed the tip");
    }

    function test_overlappingBatchesReachTheSameStateAsOneBigBatch() public {
        uint256 total = 480;
        idx.foldHeaders(_slice(0, total), new address[](0));
        int256 oneShot = idx.S();
        uint64 oneShotHeight = idx.lastHeight();

        ZkWujiIndex split = _deploy(new AcceptingVerifier());
        // Each batch folds to its own end minus CONFIRMATIONS, so the next batch must start from the
        // committed height + 1 — that is, batches overlap by exactly CONFIRMATIONS headers.
        while (split.lastHeight() + 6 < genesis + total - 1) {
            uint256 cursor = split.lastHeight() + 1 - genesis;
            uint256 size = total - cursor < 80 ? total - cursor : 80;
            split.foldHeaders(_slice(cursor, size), new address[](0));
        }
        assertEq(split.S(), oneShot, "batching must not change S");
        assertEq(split.lastHeight(), oneShotHeight);
    }

    function test_rejectsTamperedHeaders() public {
        bytes memory good = _slice(0, 40);

        bytes memory pow = good;
        pow[76] = bytes1(uint8(pow[76]) ^ 1);
        vm.expectRevert(ZkWujiIndex.BadWork.selector);
        idx.foldHeaders(pow, new address[](0));

        bytes memory link = _slice(0, 40);
        link[10] = bytes1(uint8(link[10]) ^ 1);
        vm.expectRevert(ZkWujiIndex.Linkage.selector);
        idx.foldHeaders(link, new address[](0));

        bytes memory bits = _slice(0, 40);
        bits[72] = bytes1(uint8(bits[72]) ^ 1);
        vm.expectRevert(ZkWujiIndex.Difficulty.selector);
        idx.foldHeaders(bits, new address[](0));

        vm.expectRevert(ZkWujiIndex.NotEnoughConfirmations.selector);
        idx.foldHeaders(_slice(0, 6), new address[](0));

        vm.expectRevert(ZkWujiIndex.BadLength.selector);
        idx.foldHeaders(hex"00", new address[](0));
    }

    function test_futureTimeBoundIsTheChainsNotTheSubmitters() public {
        vm.warp(1_600_000_000); // before the fixture headers were mined
        vm.expectRevert(ZkWujiIndex.FutureTime.selector);
        idx.foldHeaders(_slice(0, 40), new address[](0));
    }

    function test_recordsSeriesCheckpoints() public {
        ZkWujiIndex small = _deployWithInterval(100);
        small.foldHeaders(_slice(0, 200), new address[](0));
        assertTrue(small.checkpointed(genesis + 99), "first boundary recorded");
        assertEq(small.checkpointS(genesis + 99), _expectedU(100) * small.UNIT());
        assertTrue(small.checkpointed(genesis + 199) == false, "boundary inside the confirmation margin waits");
    }

    function _deployWithInterval(uint64 interval) internal returns (ZkWujiIndex) {
        bytes memory anchor = vm.parseBytes(string.concat("0x", vm.parseJsonString(meta, ".checkpointHeader")));
        bytes memory ancestors = vm.parseBytes(vm.readFile("test/fixtures/bitcoin-timestamps-ancestors.hex"));
        uint32[11] memory times;
        for (uint256 i = 0; i < 11; i++) {
            times[i] = _read32(ancestors, i * 80 + 68);
        }
        return new ZkWujiIndex(
            new AcceptingVerifier(), bytes32(uint256(1)), RelayerRewards(address(0)), anchor, anchorHeight,
            uint32(vm.parseJsonUint(meta, ".epochStartTime")), times, 1e30, genesis, interval
        );
    }

    // ---------------------------------------------------------------- proof path

    /// Build the journal a correct guest would emit for `count` headers, by replaying the escape hatch.
    function _journal(ZkWujiIndex from, uint256 startIndex, uint256 count)
        internal
        returns (ZkWujiIndex.Journal memory j)
    {
        ZkWujiIndex shadow = _deploy(new AcceptingVerifier());
        if (startIndex > 0) shadow.foldHeaders(_slice(0, startIndex + 6), new address[](0));
        (ZkWujiIndex.Continuity memory prev, uint32[11] memory prevTimes, uint256 prevWork) = shadow.continuity();
        shadow.foldHeaders(_slice(startIndex, count), new address[](0));
        (ZkWujiIndex.Continuity memory next, uint32[11] memory nextTimes, uint256 nextWork) = shadow.continuity();

        j.prevHash = prev.hash; j.prevHeight = prev.height; j.prevBits = prev.bits; j.prevTime = prev.time;
        j.prevEpochStart = prev.epochStart; j.prevTimes = prevTimes; j.prevU = prev.u; j.prevWork = prevWork;
        j.maxTime = uint32(block.timestamp + from.MAX_FUTURE_BLOCK_TIME());
        j.genesisHeight = from.GENESIS_HEIGHT();
        j.checkpointInterval = from.CHECKPOINT_INTERVAL();
        j.confirmations = from.CONFIRMATIONS();
        j.newHash = next.hash; j.newHeight = next.height; j.newBits = next.bits; j.newTime = next.time;
        j.newEpochStart = next.epochStart; j.newTimes = nextTimes; j.newU = next.u; j.newWork = nextWork;
        j.checkpointHeights = new uint64[](0);
        j.checkpointU = new int64[](0);
    }

    /// The whole point: a proof and raw headers must leave the index in exactly the same state.
    function test_proofPathEqualsHeaderPath() public {
        uint256 count = 200;
        ZkWujiIndex viaHeaders = _deploy(new AcceptingVerifier());
        viaHeaders.foldHeaders(_slice(0, count), new address[](0));

        ZkWujiIndex viaProof = _deploy(new AcceptingVerifier());
        ZkWujiIndex.Journal memory j = _journal(viaProof, 0, count);
        viaProof.foldProof(hex"c0ffee", abi.encode(j), new address[](0));

        assertEq(viaProof.S(), viaHeaders.S(), "S");
        assertEq(viaProof.lastHeight(), viaHeaders.lastHeight(), "height");
        assertEq(viaProof.lastHash(), viaHeaders.lastHash(), "hash");
        assertEq(viaProof.chainWork(), viaHeaders.chainWork(), "work");
        (, uint32[11] memory a,) = viaProof.continuity();
        (, uint32[11] memory b,) = viaHeaders.continuity();
        for (uint256 i = 0; i < 11; i++) {
            assertEq(a[i], b[i], "median-time-past window");
        }
    }

    function test_pathsInterleave() public {
        ZkWujiIndex mixed = _deploy(new AcceptingVerifier());
        mixed.foldHeaders(_slice(0, 100), new address[](0));
        ZkWujiIndex.Journal memory j = _journal(mixed, 94, 100);
        mixed.foldProof(hex"c0ffee", abi.encode(j), new address[](0));

        ZkWujiIndex plain = _deploy(new AcceptingVerifier());
        plain.foldHeaders(_slice(0, 100), new address[](0));
        plain.foldHeaders(_slice(94, 100), new address[](0));
        assertEq(mixed.S(), plain.S(), "a proof after headers equals headers after headers");
        assertEq(mixed.lastHeight(), plain.lastHeight());
    }

    function test_rejectsDiscontinuousOrMisconfiguredJournals() public {
        ZkWujiIndex target = _deploy(new AcceptingVerifier());
        ZkWujiIndex.Journal memory j = _journal(target, 0, 100);

        // A memory struct assignment aliases, so each variant is re-encoded from a fresh decode.
        ZkWujiIndex.Journal memory v = abi.decode(abi.encode(j), (ZkWujiIndex.Journal));
        v.prevU = j.prevU + 1;
        vm.expectRevert(ZkWujiIndex.Discontinuous.selector);
        target.foldProof(hex"00", abi.encode(v), new address[](0));

        v = abi.decode(abi.encode(j), (ZkWujiIndex.Journal));
        v.confirmations = 1;
        vm.expectRevert(ZkWujiIndex.ConfigMismatch.selector);
        target.foldProof(hex"00", abi.encode(v), new address[](0));

        v = abi.decode(abi.encode(j), (ZkWujiIndex.Journal));
        v.maxTime = uint32(block.timestamp + 1 days);
        vm.expectRevert(ZkWujiIndex.FutureTime.selector);
        target.foldProof(hex"00", abi.encode(v), new address[](0));

        v = abi.decode(abi.encode(j), (ZkWujiIndex.Journal));
        v.newHash = bytes32(uint256(1));
        target.foldProof(hex"00", abi.encode(v), new address[](0));
        assertEq(target.lastHash(), bytes32(uint256(1)), "an accepting verifier is trusted completely");
    }

    function test_aFailingVerifierCannotAdvanceTheIndex() public {
        ZkWujiIndex strict = _deploy(new RejectingVerifier());
        ZkWujiIndex.Journal memory j = _journal(strict, 0, 100);
        vm.expectRevert("bad proof");
        strict.foldProof(hex"00", abi.encode(j), new address[](0));
        assertEq(strict.lastHeight(), anchorHeight, "state unchanged");
        // the escape hatch still works with a broken prover
        strict.foldHeaders(_slice(0, 100), new address[](0));
        assertEq(strict.lastHeight(), genesis + 100 - 1 - 6);
    }

    function test_gas() public {
        uint256 g = gasleft();
        idx.foldHeaders(_slice(0, 262), new address[](0));
        uint256 headerPath = g - gasleft();
        emit log_named_uint("foldHeaders gas per header (256 folded)", headerPath / 262);

        ZkWujiIndex proofIdx = _deploy(new AcceptingVerifier());
        ZkWujiIndex.Journal memory j = _journal(proofIdx, 0, 262);
        bytes memory pv = abi.encode(j);
        g = gasleft();
        proofIdx.foldProof(hex"c0ffee", pv, new address[](0));
        uint256 proofPath = g - gasleft();
        emit log_named_uint("foldProof gas for the same 256 heights (verifier excluded)", proofPath);
        assertLt(proofPath, headerPath / 4, "the proof path must be far cheaper");
    }
}
