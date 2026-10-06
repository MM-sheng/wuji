// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ZkWujiIndex, ISP1Verifier} from "../src/ZkWujiIndex.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {WujiAccounts} from "../src/WujiAccounts.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";

/// Test-only: the production index with its difficulty floor removed, so real competing branches can be mined
/// inside a test (as T9 does with a low-difficulty relay). Every other rule is the production code.
contract EasyZkIndex is ZkWujiIndex {
    constructor(bytes memory anchor, uint64 anchorHeight, uint32[11] memory times, uint64 confirmations)
        ZkWujiIndex(
            ISP1Verifier(address(0)), bytes32(0), RelayerRewards(address(0)), anchor, anchorHeight, 0, times, 0,
            Schedule(anchorHeight + 1, 4320, confirmations), Challenge(0, 0, 0)
        )
    {}

    function targetOf(uint32 bits) public pure override returns (uint256 target) {
        uint256 size = bits >> 24;
        uint256 word = bits & 0x007fffff;
        target = size <= 3 ? word >> (8 * (3 - size)) : word << (8 * (size - 3));
    }
}

/// T13 rule 3: a branch from a recorded state that out-works the finalized chain by CONFIRMATIONS + 144 blocks
/// seals the index at once; nothing else does.
contract ZkWujiReorgTest is Test {
    uint32 constant BITS = 0x207fffff; // regtest difficulty: about every second hash qualifies
    uint64 constant ANCHOR = 100; // far from a 2016 retarget
    uint64 constant K = 6;
    uint32 constant T0 = 1_700_000_000;

    EasyZkIndex idx;
    bytes anchorHeader;
    uint32[11] anchorTimes;

    function setUp() public {
        anchorHeader = _mine(bytes32(0), T0, 0);
        for (uint256 i = 0; i < 11; i++) anchorTimes[i] = T0 - uint32(10 - i) * 600;
        idx = new EasyZkIndex(anchorHeader, ANCHOR, anchorTimes, K);
        vm.warp(T0 + 400 days); // every mined timestamp is in the past
    }

    // ---------------------------------------------------------------- mining

    function _hash(bytes memory h) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(sha256(h)));
    }

    function _mine(bytes32 parent, uint32 time, uint256 salt) internal view returns (bytes memory h) {
        h = new bytes(80);
        bytes32 merkle = keccak256(abi.encode(salt, parent));
        for (uint256 i = 0; i < 32; i++) {
            h[4 + i] = parent[i];
            h[36 + i] = merkle[i];
        }
        for (uint256 i = 0; i < 4; i++) {
            h[68 + i] = bytes1(uint8(time >> (8 * i)));
            h[72 + i] = bytes1(uint8(BITS >> (8 * i)));
        }
        uint256 target = _target();
        for (uint32 nonce = 0;; nonce++) {
            for (uint256 i = 0; i < 4; i++) h[76 + i] = bytes1(uint8(nonce >> (8 * i)));
            if (uint256(_reverse(_hash(h))) <= target) return h;
        }
    }

    function _target() internal pure returns (uint256) {
        return uint256(0x7fffff) << (8 * (0x20 - 3));
    }

    function _reverse(bytes32 v) internal pure returns (bytes32 r) {
        for (uint256 i; i < 32; i++) r |= bytes32(uint256(uint8(v[i])) << (8 * i));
    }

    /// `n` headers on top of `parent` (raw header) at heights starting `startHeight`, as one byte string.
    function _chain(bytes memory parent, uint64 startHeight, uint256 n, uint256 salt) internal view returns (bytes memory out) {
        out = new bytes(n * 80);
        bytes memory p = parent;
        for (uint256 k = 0; k < n; k++) {
            bytes memory h = _mine(_hash(p), T0 + uint32(startHeight - ANCHOR + k) * 600, salt + k);
            for (uint256 i = 0; i < 80; i++) out[k * 80 + i] = h[i];
            p = h;
        }
    }

    function _last(bytes memory chain) internal pure returns (bytes memory h) {
        h = new bytes(80);
        for (uint256 i = 0; i < 80; i++) h[i] = chain[chain.length - 80 + i];
    }

    function _at(bytes memory chain, uint256 k) internal pure returns (bytes memory h) {
        h = new bytes(80);
        for (uint256 i = 0; i < 80; i++) h[i] = chain[k * 80 + i];
    }

    function _base() internal view returns (bytes memory) {
        (ZkWujiIndex.Continuity memory c, uint32[11] memory t, uint256 w) = idx.continuity();
        return abi.encode(c, t, w);
    }

    /// Fold the main chain 60 headers past the anchor (finalized tip at ANCHOR + 54) and return it.
    function _foldMain() internal returns (bytes memory main) {
        main = _chain(anchorHeader, ANCHOR + 1, 60, 1_000_000);
        idx.foldHeaders(main, new address[](0));
        assertEq(idx.lastHeight(), ANCHOR + 54);
    }

    // ---------------------------------------------------------------- tests

    function test_theAnchorIsARecordedForkBase() public view {
        assertEq(idx.committedAt(ANCHOR), keccak256(_base()));
    }

    function test_aFoldRecordsItsFinalizedStateAndTheNewestValidatedHeader() public {
        _foldMain();
        assertEq(idx.committedAt(ANCHOR + 54), keccak256(_base()));
        assertEq(idx.seenHeight(), ANCHOR + 60);
        assertEq(idx.seenTime(), T0 + 60 * 600);
    }

    /// The work threshold is exact: one block short of the finalized chain + K + 144 does nothing.
    function test_aBranchSealsExactlyAtTheWorkThreshold() public {
        bytes memory anchorBase = _base();
        _foldMain();
        uint256 needed = 54 + K + idx.REORG_MARGIN(); // blocks of equal work past the anchor
        bytes memory branch = _chain(anchorHeader, ANCHOR + 1, needed, 7_000_000);

        bytes memory short_ = new bytes((needed - 1) * 80);
        for (uint256 i = 0; i < short_.length; i++) short_[i] = branch[i];
        vm.expectRevert(ZkWujiIndex.NoReorg.selector);
        idx.freezeOnReorg(anchorBase, short_);
        assertFalse(idx.frozen());

        int256 s = idx.S();
        idx.freezeOnReorg(anchorBase, branch);
        assertTrue(idx.frozen());
        assertEq(idx.S(), s, "S stays at the last consistent state");
        assertEq(idx.lastHeight(), ANCHOR + 54);
    }

    function test_theFinalizedChainItselfNeverSeals() public {
        bytes memory anchorBase = _base();
        bytes memory main = _foldMain();
        // Extend the main chain far past the threshold: it passes through the finalized tip, so it is no reorg.
        bytes memory longer = bytes.concat(main, _chain(_last(main), ANCHOR + 61, 160, 2_000_000));
        vm.expectRevert(ZkWujiIndex.NoReorg.selector);
        idx.freezeOnReorg(anchorBase, longer);
    }

    function test_onlyRecordedStatesBelowTheTipAreForkBases() public {
        bytes memory anchorBase = _base();
        _foldMain();
        bytes memory branch = _chain(anchorHeader, ANCHOR + 1, 210, 7_000_000);

        (ZkWujiIndex.Continuity memory c, uint32[11] memory t, uint256 w) =
            abi.decode(anchorBase, (ZkWujiIndex.Continuity, uint32[11], uint256));
        c.u += 1; // a state that was never recorded
        vm.expectRevert(ZkWujiIndex.Discontinuous.selector);
        idx.freezeOnReorg(abi.encode(c, t, w), branch);

        bytes memory tipBase = _base(); // built first: expectRevert binds the next call
        vm.expectRevert(ZkWujiIndex.NoReorg.selector); // the tip itself is not below the tip
        idx.freezeOnReorg(tipBase, branch);
    }

    function test_aBranchFromALaterRecordedStateSealsToo() public {
        bytes memory first = _chain(anchorHeader, ANCHOR + 1, 30, 1_000_000);
        idx.foldHeaders(first, new address[](0)); // finalized ANCHOR + 24
        bytes memory midBase = _base();
        bytes memory mid = _at(first, 23); // the header at ANCHOR + 24
        bytes memory rest = _chain(_last(first), ANCHOR + 31, 30, 1_500_000);
        bytes memory overlap = new bytes(6 * 80); // the last K headers of the first fold start the second
        for (uint256 i = 0; i < overlap.length; i++) overlap[i] = first[first.length - overlap.length + i];
        idx.foldHeaders(bytes.concat(overlap, rest), new address[](0)); // finalized ANCHOR + 54

        uint256 needed = (54 - 24) + K + idx.REORG_MARGIN();
        idx.freezeOnReorg(midBase, _chain(mid, ANCHOR + 25, needed, 9_000_000));
        assertTrue(idx.frozen());
    }

    function test_nothingAdvancesAfterTheSeal() public {
        bytes memory anchorBase = _base();
        bytes memory main = _foldMain();
        idx.freezeOnReorg(anchorBase, _chain(anchorHeader, ANCHOR + 1, 210, 7_000_000));

        // Arguments are mined first: mining calls the sha256 precompile, which expectRevert would bind to.
        bytes memory more = _chain(_at(main, 59), ANCHOR + 61, 10, 3_000_000);
        bytes memory heavier = _chain(anchorHeader, ANCHOR + 1, 220, 8_000_000);
        vm.expectRevert(ZkWujiIndex.IndexFrozen.selector);
        idx.foldHeaders(more, new address[](0));
        vm.expectRevert(ZkWujiIndex.IndexFrozen.selector);
        idx.freezeOnReorg(anchorBase, heavier);
        vm.expectRevert(ZkWujiIndex.IndexFrozen.selector);
        idx.finalize(1);
    }

    function testFuzz_sealsIffTheBranchReachesTheThreshold(uint8 extra, bool over) public {
        bytes memory anchorBase = _base();
        _foldMain();
        uint256 needed = 54 + K + idx.REORG_MARGIN();
        uint256 n = over ? needed + (uint256(extra) % 8) : needed - 1 - (uint256(extra) % 8);
        bytes memory branch = _chain(anchorHeader, ANCHOR + 1, n, 7_000_000);
        if (!over) vm.expectRevert(ZkWujiIndex.NoReorg.selector);
        idx.freezeOnReorg(anchorBase, branch);
        assertEq(idx.frozen(), over);
    }

    // ---------------------------------------------------------------- consumers

    /// A T11 pool on the index exits through its existing freeze path once the index is sealed: an entry priced
    /// after the last folded height is refunded in full.
    function test_aPoolOnTheIndexExitsAfterTheSeal() public {
        bytes memory anchorBase = _base();
        _foldMain();
        MockUSDT asset = new MockUSDT();
        WujiAccounts pool = new WujiAccounts(WujiAccounts.Config(
            asset, WujiIndex(address(idx)), 11.5e18, 6, 2, 30 minutes, address(0xFEE), 0, 0, 1_000, type(uint128).max, 0));
        assertTrue(pool.INDEX_CAN_FREEZE());
        address alice = address(0xA11CE);
        asset.mint(alice, 100e18);
        vm.startPrank(alice);
        asset.approve(address(pool), type(uint256).max);
        vm.warp(idx.seenTime() + 1 hours);
        uint256 id = pool.requestEnter(true, 100e18);
        vm.stopPrank();

        vm.warp(T0 + 400 days); // the branch's timestamps run ahead of the request time
        idx.freezeOnReorg(anchorBase, _chain(anchorHeader, ANCHOR + 1, 210, 7_000_000));
        pool.freezePool(10);
        assertTrue(pool.frozen());
        vm.prank(alice);
        pool.claim(id);
        assertEq(asset.balanceOf(alice), 100e18, "refunded in full: the entry was never priced");
    }
}
