// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {BitcoinRelay} from "../src/BitcoinRelay.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {WujiAccounts} from "../src/WujiAccounts.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";
import {FrozenExitRelayMock} from "./mocks/FrozenExitRelayMock.sol";

contract WujiAccountsTest is Test {
    FrozenExitRelayMock r;
    WujiIndex idx;
    WujiAccounts pool;
    MockUSDT asset;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);
    int256 constant K = 11.5e18;
    uint64 constant EPOCH = 6;
    uint64 constant DELAY = 2;

    function setUp() public {
        vm.warp(1_800_000_000);
        r = new FrozenExitRelayMock();
        idx = new WujiIndex(BitcoinRelay(address(r)), 1000, 4320, RelayerRewards(address(0)));
        asset = new MockUSDT();
        pool = make(K);
    }

    function make(int256 k) internal returns (WujiAccounts p) {
        p = new WujiAccounts(asset, idx, k, EPOCH, DELAY);
        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < 3; i++) {
            asset.mint(users[i], 1_000_000e18);
            vm.prank(users[i]);
            asset.approve(address(p), type(uint256).max);
        }
    }

    // ------------------------------------------------------------ helpers

    function advance(uint64 count) internal {
        uint64 end = idx.lastHeight() + count;
        for (uint64 h = idx.lastHeight() + 1; h <= end + 6; h++) r.put(h, keccak256(abi.encode(h, "history")));
        r.tip(end + 6, keccak256(abi.encode(end + 6, "history")), false);
        idx.fold(count);
    }

    /// Fold until `e` is folded, then process every ready epoch.
    function reach(uint64 e) internal {
        if (idx.lastHeight() < e) advance(e - idx.lastHeight());
        pool.processMany(100);
    }

    function enter(WujiAccounts p, address who, bool yang, uint128 amount) internal returns (uint256 id, uint64 e) {
        vm.prank(who);
        id = p.requestEnter(yang, amount);
        (,, e,,) = p.accounts(id);
    }

    function exit(WujiAccounts p, address who, uint256 id) internal returns (uint64 e) {
        vm.prank(who);
        p.requestExit(id);
        (,,, e,) = p.accounts(id);
    }

    function expected(uint128 principal, int256 sideSign, int256 dS, int256 k) internal pure returns (uint256) {
        int256 p = int256(uint256(principal));
        int256 v = p + p * sideSign * dS / k;
        if (v < 0) v = 0;
        if (v > 2 * p) v = 2 * p;
        return uint256(v);
    }

    // ------------------------------------------------------------ tests

    function test_markRecomputesPastS() public {
        advance(40);
        uint64 h = idx.lastHeight(); int256 s = idx.S();
        advance(300);
        assertEq(pool.mark(h, idx.lastHeight()), s);
        // chained from a mark
        advance(20);
        uint64 h2 = idx.lastHeight(); int256 s2 = idx.S();
        advance(10);
        pool.mark(h2, idx.lastHeight());
        assertEq(pool.mark(h, h2), s);
        assertEq(s2, pool.sAt(h2));
    }

    function test_pricingHeightIsNotYetMined() public {
        advance(10);
        for (uint256 i; i < 7; i++) {
            (, uint64 e) = enter(pool, alice, true, 1e18);
            assertGt(e, r.bestHeight());
            assertGe(e, r.bestHeight() + DELAY);
            assertEq(e % EPOCH, 0);
            r.tip(r.bestHeight() + 1, keccak256(abi.encode(i)), false);
        }
    }

    function test_staleRelayBlocksRequests() public {
        advance(10);
        r.setStale(true);
        vm.prank(alice);
        vm.expectRevert("relay stale");
        pool.requestEnter(true, 1e18);
    }

    function test_matchedPairIsZeroSumAndAdditive() public {
        advance(10);
        (uint256 a, uint64 e0) = enter(pool, alice, true, 100e18);
        (uint256 b,) = enter(pool, bob, false, 100e18);
        reach(e0);
        int256 s0 = pool.sAt(e0);
        advance(200);
        uint64 e1 = exit(pool, alice, a);
        reach(e1);
        int256 dS = pool.sAt(e1) - s0;
        assertApproxEqAbs(pool.valueOf(a), expected(100e18, 1, dS, K), 1);
        assertApproxEqAbs(pool.valueOf(b), expected(100e18, -1, dS, K), 1);
        assertLe(pool.valueOf(a) + pool.valueOf(b), 200e18);
        uint256 va = pool.valueOf(a);
        uint256 before = asset.balanceOf(alice);
        vm.prank(alice); pool.claim(a);
        assertEq(asset.balanceOf(alice) - before, va);
    }

    function test_exitLeavesOtherSideFullyBackedAndIdle() public {
        advance(10);
        (uint256 a, uint64 e0) = enter(pool, alice, true, 100e18);
        (uint256 b,) = enter(pool, bob, false, 100e18);
        reach(e0);
        advance(300);
        uint64 e1 = exit(pool, alice, a);
        reach(e1);
        vm.prank(alice); pool.claim(a);
        uint256 bobValue = pool.valueOf(b);
        assertGe(asset.balanceOf(address(pool)), bobValue);
        // Alone, bob is idle: more Bitcoin blocks do not move him.
        advance(300);
        (, uint64 e2) = enter(pool, carol, true, 1e18); // any request creates a new epoch
        reach(e2);
        assertEq(pool.valueOf(b), bobValue);
        uint64 e3 = exit(pool, bob, b);
        reach(e3);
        vm.prank(bob); pool.claim(b);
    }

    function test_excessSideMovesAtMatchedRate() public {
        advance(10);
        (uint256 a, uint64 e0) = enter(pool, alice, true, 200e18);
        (uint256 b,) = enter(pool, bob, false, 100e18);
        reach(e0);
        int256 s0 = pool.sAt(e0);
        advance(120);
        uint64 e1 = exit(pool, bob, b);
        reach(e1);
        int256 dS = pool.sAt(e1) - s0;
        uint256 va = pool.valueOf(a); uint256 vb = pool.valueOf(b);
        // alice gains on 100 of her 200: same absolute amount bob loses
        assertApproxEqAbs(int256(va) - 200e18, -(int256(vb) - 100e18), 1);
        assertApproxEqAbs(vb, expected(100e18, -1, dS, K), 1);
    }

    function test_noCancelAndOnlyOwner() public {
        advance(10);
        (uint256 a, uint64 e0) = enter(pool, alice, true, 1e18);
        reach(e0);
        vm.prank(bob); vm.expectRevert("not owner"); pool.requestExit(a);
        exit(pool, alice, a);
        vm.prank(alice); vm.expectRevert("exit pending"); pool.requestExit(a);
        vm.prank(alice); vm.expectRevert("not claimable"); pool.claim(a);
    }

    function test_transferMovesOwnership() public {
        advance(10);
        (uint256 a, uint64 e0) = enter(pool, alice, true, 5e18);
        reach(e0);
        vm.prank(alice); pool.transfer(a, carol);
        vm.prank(alice); vm.expectRevert("not owner"); pool.requestExit(a);
        uint64 e1 = exit(pool, carol, a);
        reach(e1);
        vm.prank(carol); pool.claim(a);
        assertEq(asset.balanceOf(carol), 1_000_000e18 + 5e18); // alone on one side: idle, value unchanged
    }

    function test_floorRetireAndCeiling() public {
        WujiAccounts p = make(0.001e18); // absurd leverage so the floor is reached in a few blocks
        advance(10);
        (uint256 a, uint64 e0) = enter(p, alice, true, 10e18);
        (uint256 b,) = enter(p, bob, false, 10e18);
        if (idx.lastHeight() < e0) advance(e0 - idx.lastHeight());
        p.processMany(10);
        advance(60);
        (, uint64 e1) = enter(p, carol, true, 1); // new epoch
        if (idx.lastHeight() < e1) advance(e1 - idx.lastHeight());
        p.processMany(10);
        uint256 va = p.valueOf(a); uint256 vb = p.valueOf(b);
        assertTrue(va == 0 || vb == 0, "one side should be at the floor");
        uint256 loser = va == 0 ? a : b; uint256 winner = va == 0 ? b : a;
        assertEq(p.valueOf(winner), 20e18);
        p.retire(loser);
        vm.expectRevert("not live");
        p.retire(loser);
        assertGe(asset.balanceOf(address(p)), p.valueOf(winner));
    }

    function test_freezeRefundsUnpricedEntriesAndPaysOpenAccounts() public {
        advance(10);
        (uint256 a, uint64 e0) = enter(pool, alice, true, 100e18);
        (uint256 b,) = enter(pool, bob, false, 100e18);
        reach(e0);
        advance(100);
        (uint256 c,) = enter(pool, carol, true, 7e18);
        // deep reorg below the folded tip, then freeze
        r.put(idx.lastHeight(), keccak256("replacement"));
        r.tip(r.bestHeight() + 1, keccak256("fork tip"), true);
        uint64 deadline = idx.observeReorg();
        r.tip(deadline, keccak256("later"), false);
        idx.freeze();
        vm.prank(alice); vm.expectRevert("pool frozen"); pool.requestEnter(true, 1);
        pool.freezePool(100);
        assertTrue(pool.frozen());
        int256 dS = idx.S() - pool.sAt(e0);
        assertApproxEqAbs(pool.valueOf(a), expected(100e18, 1, dS, K), 1);
        uint256 total = pool.valueOf(a) + pool.valueOf(b);
        vm.prank(carol); pool.claim(c);
        assertEq(asset.balanceOf(carol), 1_000_000e18);
        vm.prank(alice); pool.claim(a);
        vm.prank(bob); pool.claim(b);
        assertLe(total, 200e18);
        assertLe(asset.balanceOf(address(pool)), 10); // only rounding dust
    }

    /// Random walks with high leverage: the pool always covers every claim.
    function testFuzz_solvency(uint256 seed) public {
        WujiAccounts p = make(0.05e18);
        advance(10);
        address[3] memory users = [alice, bob, carol];
        uint256[] memory ids = new uint256[](40);
        uint256 n;
        for (uint256 round; round < 25; round++) {
            uint256 x = uint256(keccak256(abi.encode(seed, round)));
            address who = users[x % 3];
            if (x % 5 < 3 || n == 0) {
                vm.prank(who);
                ids[n++] = p.requestEnter((x >> 8) % 2 == 0, uint128(1e18 + (x >> 16) % 50e18));
            } else {
                uint256 id = ids[(x >> 24) % n];
                (address owner,,, uint64 ex,) = p.accounts(id);
                (,, bool processed) = p.epochAcc(_enterEpoch(p, id));
                if (owner != address(0) && ex == 0 && processed) {
                    if (p.valueOf(id) == 0) p.retire(id);
                    else { vm.prank(owner); try p.requestExit(id) {} catch {} }
                }
            }
            advance(uint64(1 + (x >> 32) % 20));
            p.processMany(50);
            _claimAndCheck(p, ids, n);
        }
    }

    /// Claim anything claimable, then check solvency against every remaining account.
    function _claimAndCheck(WujiAccounts p, uint256[] memory ids, uint256 n) internal {
        uint256 owed; uint256 unretired;
        for (uint256 i; i < n; i++) {
            (address owner,,, uint64 ex, uint128 principal) = p.accounts(ids[i]);
            if (owner == address(0)) continue;
            (,, bool entered) = p.epochAcc(_enterEpoch(p, ids[i]));
            if (!entered) { owed += principal; continue; }
            bool exited;
            if (ex != 0) (,, exited) = p.epochAcc(ex);
            if (exited) { vm.prank(owner); p.claim(ids[i]); continue; }
            owed += p.valueOf(ids[i]);
            int256 raw = p.rawValueOf(ids[i]);
            if (raw < 0) unretired += uint256(-raw);
        }
        // The only shortfall is losses past the floor: recorded ones plus those of accounts not yet retired.
        assertGe(asset.balanceOf(address(p)) + p.badDebt() + unretired, owed, "insolvent beyond floor overshoot");
    }

    function _enterEpoch(WujiAccounts p, uint256 id) internal view returns (uint64 e) {
        (,, e,,) = p.accounts(id);
    }
}
