// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WujiHeaderIndex} from "../src/WujiHeaderIndex.sol";
import {ZkWujiIndex, ISP1Verifier} from "../src/ZkWujiIndex.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";

/// Rules 1 and 2 of the mainnet index over real mainnet headers, and a differential check that it computes
/// exactly what ZkWujiIndex's header path computes (the rule code was carried over unchanged).
contract WujiHeaderIndexTest is Test {
    bytes headers;
    string meta;
    uint64 anchorHeight;
    uint64 genesis;
    bytes anchor;
    uint32[11] times;
    WujiHeaderIndex idx;

    function setUp() public {
        meta = vm.readFile("test/fixtures/bitcoin-timestamps.json");
        headers = vm.parseBytes(vm.readFile("test/fixtures/bitcoin-timestamps.hex"));
        anchorHeight = uint64(vm.parseJsonUint(meta, ".checkpointHeight"));
        genesis = uint64(vm.parseJsonUint(meta, ".start"));
        anchor = vm.parseBytes(string.concat("0x", vm.parseJsonString(meta, ".checkpointHeader")));
        bytes memory ancestors = vm.parseBytes(vm.readFile("test/fixtures/bitcoin-timestamps-ancestors.hex"));
        for (uint256 i = 0; i < 11; i++) {
            uint256 at = i * 80 + 68;
            times[i] = uint32(uint8(ancestors[at])) | uint32(uint8(ancestors[at + 1])) << 8
                | uint32(uint8(ancestors[at + 2])) << 16 | uint32(uint8(ancestors[at + 3])) << 24;
        }
        idx = _deploy(6, 4320);
        vm.warp(1_800_000_000);
    }

    function _deploy(uint64 confirmations, uint64 interval) internal returns (WujiHeaderIndex) {
        return new WujiHeaderIndex(
            RelayerRewards(address(0)), anchor, anchorHeight, uint32(vm.parseJsonUint(meta, ".epochStartTime")), times, 0,
            genesis, interval, confirmations
        );
    }

    function _slice(uint256 start, uint256 count) internal view returns (bytes memory out) {
        out = new bytes(count * 80);
        for (uint256 i = 0; i < count * 80; i++) out[i] = headers[start * 80 + i];
    }

    function _expectedU(uint256 count) internal view returns (int256 u) {
        for (uint256 i = 0; i < count; i++) {
            bytes32 hash = sha256(abi.encodePacked(sha256(_slice(i, 1))));
            u += int256(idx.byteSum(sha256(abi.encodePacked(hash)))) - 4080;
        }
    }

    function test_foldStopsAtTheConfirmationDepth() public {
        idx.foldHeaders(_slice(0, 60), new address[](0));
        assertEq(idx.lastHeight(), genesis + 60 - 1 - 6);
        assertEq(idx.S(), _expectedU(54) * idx.UNIT());
        assertEq(idx.seenHeight(), genesis + 59, "the trailing headers were validated and recorded as seen");
    }

    function test_theConfirmationDepthIsTheDeploymentParameter() public {
        WujiHeaderIndex deep = _deploy(100, 4320);
        vm.expectRevert(WujiHeaderIndex.NotEnoughConfirmations.selector);
        deep.foldHeaders(_slice(0, 100), new address[](0));
        deep.foldHeaders(_slice(0, 150), new address[](0));
        assertEq(deep.lastHeight(), genesis + 150 - 1 - 100);
        assertEq(deep.S(), _expectedU(50) * deep.UNIT());
    }

    function test_overlappingBatchesReachTheSameStateAsOneBigBatch() public {
        idx.foldHeaders(_slice(0, 480), new address[](0));
        WujiHeaderIndex split = _deploy(6, 4320);
        while (split.lastHeight() + 6 < genesis + 480 - 1) {
            uint256 cursor = split.lastHeight() + 1 - genesis;
            uint256 size = 480 - cursor < 80 ? 480 - cursor : 80;
            split.foldHeaders(_slice(cursor, size), new address[](0));
        }
        assertEq(split.S(), idx.S());
        assertEq(split.lastHash(), idx.lastHash());
    }

    function test_rejectsTamperedHeaders() public {
        bytes memory pow = _slice(0, 40);
        pow[76] = bytes1(uint8(pow[76]) ^ 1);
        vm.expectRevert(WujiHeaderIndex.BadWork.selector);
        idx.foldHeaders(pow, new address[](0));
        bytes memory link = _slice(0, 40);
        link[10] = bytes1(uint8(link[10]) ^ 1);
        vm.expectRevert(WujiHeaderIndex.Linkage.selector);
        idx.foldHeaders(link, new address[](0));
        bytes memory bits = _slice(0, 40);
        bits[72] = bytes1(uint8(bits[72]) ^ 1);
        vm.expectRevert(WujiHeaderIndex.Difficulty.selector);
        idx.foldHeaders(bits, new address[](0));
        bytes memory short_ = _slice(0, 6);
        vm.expectRevert(WujiHeaderIndex.NotEnoughConfirmations.selector);
        idx.foldHeaders(short_, new address[](0));
    }

    function test_futureTimeBoundIsTheChainsNotTheSubmitters() public {
        bytes memory batch = _slice(0, 40);
        vm.warp(1_600_000_000);
        vm.expectRevert(WujiHeaderIndex.FutureTime.selector);
        idx.foldHeaders(batch, new address[](0));
    }

    function test_recordsSeriesCheckpoints() public {
        WujiHeaderIndex small = _deploy(6, 100);
        small.foldHeaders(_slice(0, 200), new address[](0));
        assertTrue(small.checkpointed(genesis + 99));
        assertEq(small.checkpointS(genesis + 99), _expectedU(100) * small.UNIT());
        assertFalse(small.checkpointed(genesis + 199), "a boundary inside the confirmation margin waits");
    }

    function test_rejectsBadConfiguration() public {
        vm.expectRevert(WujiHeaderIndex.ConfigMismatch.selector);
        _deploy(0, 4320);
        vm.expectRevert(WujiHeaderIndex.ConfigMismatch.selector);
        _deploy(6, 0);
    }

    /// The rule code was carried over from ZkWujiIndex unchanged: both must reach identical state.
    function test_sameStateAsZkWujiIndexHeaderPath() public {
        ZkWujiIndex zk = new ZkWujiIndex(
            ISP1Verifier(address(0)), bytes32(0), RelayerRewards(address(0)), anchor, anchorHeight,
            uint32(vm.parseJsonUint(meta, ".epochStartTime")), times, 0, ZkWujiIndex.Schedule(genesis, 100, 6),
            ZkWujiIndex.Challenge(0, 0, 0)
        );
        WujiHeaderIndex h = _deploy(6, 100);
        for (uint256 cursor = 0; cursor + 6 < 1000;) {
            uint256 size = 1000 - cursor < 400 ? 1000 - cursor : 400;
            zk.foldHeaders(_slice(cursor, size), new address[](0));
            h.foldHeaders(_slice(cursor, size), new address[](0));
            cursor = h.lastHeight() + 1 - genesis;
        }
        assertEq(h.S(), zk.S(), "S");
        assertEq(h.lastHash(), zk.lastHash(), "hash");
        assertEq(h.chainWork(), zk.chainWork(), "work");
        assertEq(h.seenHeight(), zk.seenHeight(), "seen");
        for (uint64 b = genesis + 99; b < genesis + 1000; b += 100) {
            assertEq(h.checkpointed(b), zk.checkpointed(b));
            assertEq(h.checkpointS(b), zk.checkpointS(b));
        }
    }

    function test_gas() public {
        bytes memory raw = _slice(0, 350);
        WujiHeaderIndex deep = _deploy(100, 4320);
        uint256 g = gasleft();
        deep.foldHeaders(raw, new address[](0));
        emit log_named_uint("foldHeaders 350 headers, K = 100 (250 folded), gas", g - gasleft());
    }
}
