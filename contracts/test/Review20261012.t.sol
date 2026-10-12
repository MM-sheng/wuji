// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {WujiAccountsHeaderIndexTest} from "./WujiAccounts.headerIndex.t.sol";
import {WujiHeaderIndexReorgTest, EasyHeaderIndex} from "./WujiHeaderIndex.reorg.t.sol";
import {WujiHeaderIndex} from "../src/WujiHeaderIndex.sol";
import {WujiAccounts} from "../src/WujiAccounts.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";

/// Regression cases converted from the 2026-10-12 audit reproductions.
contract Review20261012RealHeaders is WujiAccountsHeaderIndexTest {
    function test_reviewMarkedTipRemainsAUsableKeeperAnchor() public {
        vm.warp(idx.seenTime() + 20 hours);
        vm.prank(alice);
        uint256 slow = pool.requestEnter(true, 100e18);
        idx.foldHeaders(_headers(idx.lastHeight(), 60), new address[](0));
        vm.prank(bob);
        uint256 fast = pool.requestEnter(false, 100e18);
        (,, uint64 high,,) = pool.accounts(slow);
        (,, uint64 low,,) = pool.accounts(fast);
        assertLt(low, high);
        vm.warp(1_800_000_000);
        idx.foldHeaders(_headers(idx.lastHeight(), high - idx.lastHeight() + 6), new address[](0));
        assertEq(idx.lastHeight(), high);

        // A permissionless zero-length relay walk succeeds on the relay-less production contract.
        vm.prank(address(0xBAD));
        pool.mark(high, high);
        assertTrue(pool.marked(high));
        assertEq(pool.hashAt(high), idx.lastHash());
        idx.foldHeaders(_headers(high, 20), new address[](0));
        bytes memory lowerHeaders = _headers(low, high - low);
        pool.markWithHeaders(low, high, lowerHeaders);
        pool.markWithHeaders(high, idx.lastHeight(), _headers(high, idx.lastHeight() - high));
        assertEq(pool.processMany(8), 2);
    }

    function test_reviewFreezeWaitsForTheSameAuthenticatedHistoricalPrice() public {
        vm.warp(idx.seenTime() + 10 minutes);
        vm.prank(alice);
        uint256 a = pool.requestEnter(true, 100e18);
        vm.prank(bob);
        pool.requestEnter(false, 100e18);
        (,, uint64 e,,) = pool.accounts(a);
        vm.warp(1_800_000_000);
        idx.foldHeaders(_headers(idx.lastHeight(), e - idx.lastHeight() + 46), new address[](0));
        uint64 tipHeight = idx.lastHeight();
        assertLt(e, tipHeight);
        // Model the already-sealed index condition only. S/hash/history are the real fixture's values.
        vm.mockCall(address(idx), abi.encodeWithSignature("frozen()"), abi.encode(true));
        uint256 snapshot = vm.snapshotState();
        pool.freezePool(50);
        assertFalse(pool.frozen(), "an absent historical price cannot select a fallback");
        assertEq(pool.head(), 0);
        pool.markWithHeaders(e, tipHeight, _headers(e, tipHeight - e));
        pool.freezePool(50);
        uint256 delayedValue = pool.valueOf(a);

        assertTrue(vm.revertToState(snapshot));
        // Historical headers remain verifiable against the sealed header index's final hash.
        pool.markWithHeaders(e, tipHeight, _headers(e, tipHeight - e));
        pool.freezePool(50);
        uint256 markedValue = pool.valueOf(a);
        assertEq(markedValue, delayedValue, "marking order cannot select the settlement price");
        assertTrue(pool.frozen());
    }
}

/// Accounting fixture only: does not claim to forge PoW or make these prices occur on demand.
contract ReviewAccountingIndex {
    uint64 public lastHeight = 1000;
    uint64 public seenHeight = 1100;
    uint32 public seenTime;
    int256 public S;
    bool public frozen;
    constructor() { seenTime = uint32(block.timestamp); }
    function lastHash() external pure returns (bytes32) { return keccak256("accounting fixture"); }
    function advance(uint64 h, int256 s) external {
        require(h > lastHeight);
        lastHeight = h; seenHeight = h + 100; seenTime = uint32(block.timestamp); S = s;
    }
    function seal() external { frozen = true; }
}

contract Review20261012Accounting is Test {
    ReviewAccountingIndex idx;
    MockUSDT token;
    WujiAccounts pool;
    address constant alice = address(0xA11CE);
    address constant bob = address(0xB0B);
    address constant carol = address(0xCA201);

    function setUp() public {
        vm.warp(1_800_000_000);
        idx = new ReviewAccountingIndex();
        token = new MockUSDT();
        pool = new WujiAccounts(WujiAccounts.Config(
            token, WujiIndex(address(idx)), 4.6e18, 6, 16, 30 minutes, address(0xFEE), 30, 10_000, 1000
        ));
        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < users.length; ++i) {
            token.mint(users[i], 1000e18);
            vm.prank(users[i]); token.approve(address(pool), type(uint256).max);
        }
    }

    function test_reviewInsolvencyProtectsPendingDepositsInEitherClaimOrder() public {
        vm.prank(alice); uint256 a = pool.requestEnter(true, 100e18);
        vm.prank(bob); uint256 b = pool.requestEnter(false, 10e18);
        (,, uint64 entry,,) = pool.accounts(a);
        idx.advance(entry, 0); pool.processMany(8);
        // A long-lived unbalanced book eventually crosses the smaller side's floor.
        idx.advance(entry + 200_000, 9.2e18);
        vm.prank(alice); pool.requestExit(a);
        (,,, uint64 exitEpoch,) = pool.accounts(a);
        // The new entrant arrives before the next epoch recognizes the existing book's shortfall.
        vm.prank(carol); uint256 c = pool.requestEnter(true, 100e18);
        (,,,, uint128 refundDue) = pool.accounts(c);
        assertEq(pool.pendingPrincipal(), refundDue);
        idx.advance(exitEpoch, 9.2e18); pool.processMany(8);
        assertLt(pool.rawValueOf(b), 0);
        assertGt(pool.badDebt(), 0);
        assertTrue(pool.insolvent());
        assertTrue(pool.frozen());
        assertFalse(pool.acceptingRequests());
        uint256 winnerDue = pool.valueOf(a);
        uint256 snapshot = vm.snapshotState();
        uint256 before = token.balanceOf(carol);
        vm.prank(alice); pool.claim(a);
        vm.prank(carol); pool.claim(c);
        uint256 lateRefund = token.balanceOf(carol) - before;
        assertEq(lateRefund, refundDue, "unpriced principal cannot subsidize pre-existing losses");
        (address deleted,,,,) = pool.accounts(c);
        assertEq(deleted, address(0), "the full refund was paid");
        assertTrue(vm.revertToState(snapshot));
        before = token.balanceOf(carol);
        vm.prank(carol); pool.claim(c);
        uint256 earlyRefund = token.balanceOf(carol) - before;
        assertEq(earlyRefund, refundDue);
        before = token.balanceOf(alice);
        vm.prank(alice); pool.claim(a);
        assertEq(token.balanceOf(alice) - before, winnerDue);
        vm.prank(bob); pool.claim(b);
        assertEq(pool.pendingPrincipal(), 0);
    }
}

contract Review20261012ReorgLimit is WujiHeaderIndexReorgTest {
    function _segment(bytes memory data, uint256 start, uint256 count) internal pure returns (bytes memory out) {
        out = new bytes(count * 80);
        for (uint256 i; i < out.length; ++i) out[i] = data[start * 80 + i];
    }

    function test_reviewValidDeepReorgCannotFitTheSealProofLimit() public {
        idx = new EasyHeaderIndex(anchorHeader, ANCHOR, anchorTimes, 100);
        bytes memory base = _base();
        bytes memory main = _chain(anchorHeader, ANCHOR + 1, 657, 1_000_000);
        idx.foldHeaders(_segment(main, 0, 350), new address[](0));
        idx.foldHeaders(_segment(main, 250, 350), new address[](0));
        idx.foldHeaders(_segment(main, 500, 157), new address[](0));
        assertEq(idx.lastHeight(), ANCHOR + 557);
        // At equal difficulty a competing branch needs 557 + 100 + 144 = 801 headers.
        bytes memory branch = _chain(anchorHeader, ANCHOR + 1, 801, 7_000_000);
        EasyHeaderIndex other = new EasyHeaderIndex(anchorHeader, ANCHOR, anchorTimes, 100);
        other.foldHeaders(_segment(branch, 0, 512), new address[](0));
        other.foldHeaders(_segment(branch, 412, 389), new address[](0));
        assertEq(other.seenHeight(), ANCHOR + 801, "all competing headers validate under the same rules");
        bytes memory tooShort = _segment(branch, 0, 800);
        vm.expectRevert(WujiHeaderIndex.NoReorg.selector);
        idx.freezeOnReorg(base, tooShort);
        vm.expectRevert(WujiHeaderIndex.TooManyHeaders.selector);
        idx.freezeOnReorg(base, branch);
        assertFalse(idx.frozen());
        bytes memory replacement = _segment(branch, 557, 101);
        vm.expectRevert(WujiHeaderIndex.Linkage.selector);
        idx.foldHeaders(replacement, new address[](0));
    }
}
