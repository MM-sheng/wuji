// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Review20261012Accounting} from "./Review20261012.t.sol";

contract WujiAccountsSolvencyFixTest is Review20261012Accounting {
    function _enter(address who, bool side, uint128 amount) internal returns (uint256 id) {
        vm.prank(who); id = pool.requestEnter(side, amount);
    }
    function _entry(uint256 id) internal view returns (uint64 e) { (,, e,,) = pool.accounts(id); }
    function _exit(uint256 id) internal view returns (uint64 e) { (,,, e,) = pool.accounts(id); }
    function _claim(address who, uint256 id) internal returns (uint256 paid) {
        uint256 before = token.balanceOf(who);
        vm.prank(who); pool.claim(id);
        return token.balanceOf(who) - before;
    }

    function testFuzz_multipleCreditorsReceiveTheSameAllocationInEitherOrder(uint96 aSeed, uint96 cSeed) public {
        uint256 a = _enter(alice, true, uint128(bound(aSeed, 100e18, 500e18)));
        uint256 c = _enter(carol, true, uint128(bound(cSeed, 100e18, 500e18)));
        uint256 b = _enter(bob, false, 10e18);
        idx.advance(_entry(a), 0); pool.processMany(8);
        idx.advance(idx.lastHeight() + 200_000, 9.2e18);
        vm.prank(alice); pool.requestExit(a);
        uint256 pending = _enter(bob, false, 20e18);
        idx.advance(_exit(a), 9.2e18); pool.processMany(8);
        assertTrue(pool.insolvent());
        uint256 av = pool.valueOf(a); uint256 cv = pool.valueOf(c);
        uint256 snapshot = vm.snapshotState();
        assertEq(_claim(alice, a), av);
        assertEq(_claim(carol, c), cv);
        assertEq(_claim(bob, pending), 19.94e18);
        assertEq(_claim(bob, b), 0);
        assertTrue(vm.revertToState(snapshot));
        assertEq(_claim(bob, pending), 19.94e18);
        assertEq(_claim(carol, c), cv);
        assertEq(_claim(alice, a), av);
        assertEq(_claim(bob, b), 0);
        assertLe(token.balanceOf(address(pool)), 2, "only pro-rata rounding dust remains");
    }

    function test_previouslyPricedExitHasCashReservedBeforeLaterInsolvency() public {
        uint256 a = _enter(alice, true, 100e18);
        _enter(bob, false, 10e18);
        uint256 c = _enter(carol, true, 20e18);
        idx.advance(_entry(a), 0); pool.processMany(8);
        vm.prank(carol); pool.requestExit(c);
        idx.advance(_exit(c), 0); pool.processMany(8);
        uint256 reserved = pool.exitClaim(c);
        assertEq(pool.reservedClaims(), reserved);
        idx.advance(idx.lastHeight() + 200_000, 9.2e18);
        vm.prank(alice); pool.requestExit(a);
        idx.advance(_exit(a), 9.2e18); pool.processMany(8);
        assertTrue(pool.insolvent());
        uint256 winner = pool.valueOf(a);
        uint256 snapshot = vm.snapshotState();
        assertEq(_claim(alice, a), winner);
        assertEq(_claim(carol, c), reserved);
        assertTrue(vm.revertToState(snapshot));
        assertEq(_claim(carol, c), reserved);
        assertEq(_claim(alice, a), winner);
        assertEq(pool.reservedClaims(), 0);
    }

    function test_netFloorOvershootConsumesBufferBeforeClosingThePool() public {
        uint256 a = _enter(alice, true, 100e18);
        _enter(bob, false, 10e18);
        idx.advance(_entry(a), 0); pool.processMany(8);
        uint256 initialBuffer = pool.buffer();
        idx.advance(idx.lastHeight() + 200_000, 4.65e18);
        uint256 c = _enter(carol, false, 1e18);
        idx.advance(_entry(c), 4.65e18); pool.processMany(8);
        assertFalse(pool.frozen());
        assertEq(pool.badDebt(), 0);
        assertLt(pool.buffer(), initialBuffer);
        assertGe(token.balanceOf(address(pool)), pool.valueOf(a) + pool.valueOf(c) + pool.buffer());
    }

    function test_largeEpochIsBoundedAndAllExitsAreReservedBeforeClaims() public {
        uint256 first;
        for (uint256 i; i < 130; i++) {
            uint256 id = _enter(alice, i % 2 == 0, 1e18);
            if (i == 0) first = id;
        }
        idx.advance(_entry(first), 0);
        uint256 gasBefore = gasleft();
        assertEq(pool.processMany(1), 0);
        assertLt(gasBefore - gasleft(), 8_000_000);
        assertTrue(pool.settling());
        assertFalse(pool.acceptingRequests());
        vm.expectRevert("settlement pending"); pool.sweep();
        vm.prank(alice); vm.expectRevert("settlement pending"); pool.requestEnter(true, 1e18);
        assertEq(pool.processMany(1), 0);
        assertEq(pool.processMany(1), 1);
        assertFalse(pool.settling());
        assertEq(pool.pendingPrincipal(), 0);
        for (uint256 i; i < 130; i++) { vm.prank(alice); pool.requestExit(first + i); }
        idx.advance(_exit(first), 0);
        assertEq(pool.processMany(1), 0);
        vm.prank(alice); vm.expectRevert("not claimable"); pool.claim(first);
        assertEq(pool.processMany(1), 0);
        assertEq(pool.processMany(1), 1);
        uint256 net = 0.997e18 - uint256(0.997e18) * 30 / 10_000;
        assertEq(pool.reservedClaims(), 130 * net);
        for (uint256 i; i < 130; i++) assertEq(_claim(alice, first + i), net);
        assertEq(pool.reservedClaims(), 0);
        assertEq(pool.openAccounts(), 0);
    }

    function test_reservedExitCanBeClaimedWhileAnotherEpochIsBeingScanned() public {
        uint256 c = _enter(carol, true, 20e18);
        idx.advance(_entry(c), 0); pool.processMany(8);
        vm.prank(carol); pool.requestExit(c);
        idx.advance(_exit(c), 0); pool.processMany(8);
        uint256 due = pool.exitClaim(c);
        uint256 first;
        for (uint256 i; i < 70; i++) {
            uint256 id = _enter(alice, i % 2 == 0, 1e18);
            if (i == 0) first = id;
        }
        idx.advance(_entry(first), 0);
        pool.processMany(1);
        assertTrue(pool.settling());
        assertEq(_claim(carol, c), due);
        assertEq(pool.processMany(1), 1);
        assertFalse(pool.settling());
        assertGe(token.balanceOf(address(pool)), 70 * uint256(0.997e18) + pool.buffer());
    }

    function test_accountBudgetIsSharedAcrossEpochsInOneTransaction() public {
        for (uint256 i; i < 40; i++) _enter(alice, i % 2 == 0, 1e18);
        uint64 firstEpoch = _entry(1);
        idx.advance(firstEpoch, 0);
        pool.mark(firstEpoch, firstEpoch);
        for (uint256 i; i < 40; i++) _enter(bob, i % 2 == 0, 1e18);
        idx.advance(_entry(41), 0);
        // Joining 40 consumes most of this transaction's budget. Scanning the same book for the next
        // epoch must stop after another 24 visits, even when max permits eight completed epochs.
        assertEq(pool.processMany(8), 1);
        assertTrue(pool.settling());
        assertEq(pool.head(), 1);
        assertEq(pool.pendingPrincipal(), 40 * uint256(0.997e18));
        assertEq(pool.processMany(8), 1);
        assertFalse(pool.settling());
        assertEq(pool.pendingPrincipal(), 0);
    }

    function test_refundCanBeClaimedDuringBatchedFinalFreeze() public {
        for (uint256 i; i < 70; i++) _enter(alice, i % 2 == 0, 1e18);
        idx.advance(_entry(1), 0);
        pool.processMany(1); pool.processMany(1);
        uint256 refund = _enter(carol, true, 5e18);
        idx.seal();
        pool.freezePool(1);
        assertTrue(pool.settling());
        assertEq(pool.refundReserve(), 0);
        pool.freezePool(1);
        assertTrue(pool.settling(), "the final live book still needs another batch");
        assertFalse(pool.frozen());
        assertEq(pool.refundReserve(), 4.985e18);
        assertEq(_claim(carol, refund), 4.985e18);
        assertEq(pool.refundReserve(), 0);
        pool.freezePool(1);
        assertTrue(pool.frozen());
        assertFalse(pool.settling());
        for (uint256 i; i < 70; i++) assertEq(_claim(alice, i + 1), 0.997e18);
        assertEq(pool.openAccounts(), 0);
        assertGe(token.balanceOf(address(pool)), pool.buffer());
    }
}
