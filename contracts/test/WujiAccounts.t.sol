// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {BitcoinRelay} from "../src/BitcoinRelay.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {WujiAccounts} from "../src/WujiAccounts.sol";
import {WujiAccountsFactory} from "../src/WujiAccountsFactory.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";
import {MockWstETH} from "./mocks/MockWstETH.sol";
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
    address treasury = address(0xFEE);
    uint256 FEE = 0;          // most tests check the pure mechanism; fee tests set it
    uint256 BOUNTY = 0;

    function setUp() public {
        vm.warp(1_800_000_000);
        r = new FrozenExitRelayMock();
        idx = new WujiIndex(BitcoinRelay(address(r)), 1000, 4320, RelayerRewards(address(0)));
        asset = new MockUSDT();
        pool = make(K);
    }

    function make(int256 k) internal returns (WujiAccounts p) {
        p = new WujiAccounts(WujiAccounts.Config(asset, idx, k, EPOCH, DELAY, 30 minutes, treasury, FEE, BOUNTY, 1_000));
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

    /// Raw headers for heights with the relay mock's hashes are not available, so this test builds a
    /// linked header chain, folds it through a real WujiIndex, and marks from the headers alone.
    function test_markWithHeadersNeedsOnlyTheTipHash() public {
        advance(10);
        uint64 base = idx.lastHeight();
        bytes32 prev = r.headerAt(base);
        bytes memory all;
        for (uint64 h = base + 1; h <= base + 30; h++) {
            bytes memory raw = abi.encodePacked(uint32(0x20000000), prev, keccak256(abi.encode(h)), uint32(h), uint32(0x1d00ffff), uint32(h));
            prev = sha256(abi.encodePacked(sha256(raw)));
            r.put(h, prev);
            all = abi.encodePacked(all, raw);
        }
        for (uint64 h = base + 31; h <= base + 36; h++) r.put(h, keccak256(abi.encode(h, "later")));
        r.tip(base + 36, keccak256(abi.encode(base + 36, "later")), false);
        idx.fold(12);                       // folds base+1 .. base+12
        int256 s12 = idx.S(); uint64 h12 = idx.lastHeight();
        idx.fold(18);                       // folds to base+30
        assertEq(idx.lastHash(), prev);
        // Mark base+12 from the 18 headers above it, anchored on the index's lastHash only.
        bytes memory upper = _slice(all, 12 * 80, 18 * 80);
        assertEq(pool.markWithHeaders(h12, base + 30, upper), s12);
        assertEq(pool.hashAt(h12), r.headerAt(h12));
        // Chained from that mark down to base+4, and equal to the relay-walk result.
        int256 s4 = pool.markWithHeaders(base + 4, h12, _slice(all, 4 * 80, 8 * 80));
        WujiAccounts other = make(K);
        assertEq(other.mark(base + 4, idx.lastHeight()), s4);
        // One altered byte anywhere breaks the linkage.
        bytes memory bad = _slice(all, 12 * 80, 18 * 80);
        bad[100] = bytes1(uint8(bad[100]) ^ 1);
        WujiAccounts third = make(K);
        vm.expectRevert("linkage");
        third.markWithHeaders(h12, base + 30, bad);
        vm.expectRevert("headers");
        third.markWithHeaders(h12, base + 31, upper);
    }

    function _slice(bytes memory b, uint256 from, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i; i < len; i++) out[i] = b[from + i];
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

    /// The index would still fold with a 2h-old relay tip; the pool refuses to price against it.
    function test_poolFreshnessIsTighterThanTheIndex() public {
        advance(10);
        r.setAge(31 minutes);
        vm.prank(alice); vm.expectRevert("relay stale"); pool.requestEnter(true, 1e18);
        assertTrue(idx.relayFresh());
        r.setAge(29 minutes);
        vm.prank(alice); pool.requestEnter(true, 1e18);
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

    function test_feesBufferBountiesAndSweep() public {
        FEE = 30; BOUNTY = 0.05e18;
        WujiAccounts p = make(K);
        advance(10);
        (uint256 a, uint64 e0) = enter(p, alice, true, 100e18);
        (uint256 b,) = enter(p, bob, false, 100e18);
        (,,,, uint128 principal) = p.accounts(a);
        assertEq(principal, 100e18 - 0.3e18);
        assertEq(p.buffer(), 0.6e18);
        if (idx.lastHeight() < e0) advance(e0 - idx.lastHeight());
        uint256 carolBefore = asset.balanceOf(carol);
        vm.prank(carol);
        p.processMany(10);
        assertEq(asset.balanceOf(carol) - carolBefore, BOUNTY, "processing pays a bounty");
        assertEq(p.buffer(), 0.55e18);
        // Buffer above 10% of principal is swept; here it is below target.
        assertEq(p.sweep(), 0);
        uint64 e1 = exit(p, alice, a);
        if (idx.lastHeight() < e1) advance(e1 - idx.lastHeight());
        p.processMany(10);
        uint256 v = p.valueOf(a);
        uint256 before = asset.balanceOf(alice);
        vm.prank(alice); p.claim(a);
        assertEq(asset.balanceOf(alice) - before, v - v * 30 / 10_000);
        b;
    }

    function test_badDebtAbsorbedByBufferFirst() public {
        FEE = 100; BOUNTY = 0;
        WujiAccounts p = make(0.001e18);
        advance(10);
        (uint256 a, uint64 e0) = enter(p, alice, true, 10e18);
        (uint256 b,) = enter(p, bob, false, 10e18);
        if (idx.lastHeight() < e0) advance(e0 - idx.lastHeight());
        p.processMany(10);
        advance(60);
        (, uint64 e1) = enter(p, carol, true, 1e18);
        if (idx.lastHeight() < e1) advance(e1 - idx.lastHeight());
        p.processMany(10);
        uint256 loser = p.valueOf(a) == 0 ? a : b;
        int256 raw = p.rawValueOf(loser);
        uint256 bufferBefore = p.buffer();
        p.retire(loser);
        uint256 debt = uint256(-raw);
        uint256 absorbed = debt < bufferBefore ? debt : bufferBefore;
        assertEq(p.buffer(), bufferBefore - absorbed);
        assertEq(p.badDebt(), debt - absorbed);
    }

    function test_factoryFixesTheMenu() public {
        WujiAccountsFactory f = new WujiAccountsFactory(idx, treasury, EPOCH, DELAY, 30 minutes, 30, 1_000);
        WujiAccounts[3] memory pools = f.create(asset, 0.01e18);
        assertEq(pools[0].K(), 23e18);
        assertEq(pools[1].K(), 11.5e18);
        assertEq(pools[2].K(), 4.6e18);
        assertEq(address(f.pool(address(asset), 1)), address(pools[1]));
        vm.expectRevert("exists");
        f.create(asset, 0);
    }

    /// Invariant 7: yield accrues to holders through the token's own NAV and never enters the bet.
    function test_yieldTokenNavAccruesOutsideTheBet() public {
        MockWstETH w = new MockWstETH();
        WujiAccounts p = new WujiAccounts(WujiAccounts.Config(w, idx, K, EPOCH, DELAY, 30 minutes, treasury, 0, 0, 1_000));
        w.mint(alice, 100e18); w.mint(bob, 100e18);
        vm.prank(alice); w.approve(address(p), type(uint256).max);
        vm.prank(bob); w.approve(address(p), type(uint256).max);
        advance(10);
        (uint256 a, uint64 e0) = enter(p, alice, true, 100e18);
        (uint256 b,) = enter(p, bob, false, 100e18);
        if (idx.lastHeight() < e0) advance(e0 - idx.lastHeight());
        p.processMany(10);
        int256 s0 = p.sAt(e0);
        advance(150);
        w.accrue(300); // a year of ~3% staking yield
        uint64 e1 = exit(p, alice, a);
        uint64 e2 = exit(p, bob, b);
        assertEq(e1, e2);
        if (idx.lastHeight() < e1) advance(e1 - idx.lastHeight());
        p.processMany(10);
        int256 dS = p.sAt(e1) - s0;
        // P&L is in token units and ignores the NAV change entirely.
        assertApproxEqAbs(p.valueOf(a), expected(100e18, 1, dS, K), 1);
        vm.prank(alice); p.claim(a);
        vm.prank(bob); p.claim(b);
        uint256 ta = w.balanceOf(alice); uint256 tb = w.balanceOf(bob);
        assertLe(ta + tb, 200e18);
        assertGe(ta + tb, 200e18 - 2);
        // Both sides earned the 3% on what they hold, in ETH terms.
        assertEq(w.getStETHByWstETH(ta), ta * 10_300 / 10_000);
    }

    /// Random walks with high leverage: the pool always covers every claim.
    function testFuzz_solvency(uint256 seed) public {
        FEE = 30; BOUNTY = 0.01e18;
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
        assertGe(asset.balanceOf(address(p)) + p.badDebt() + unretired, owed + p.buffer(), "insolvent beyond floor overshoot");
    }

    function _enterEpoch(WujiAccounts p, uint256 id) internal view returns (uint64 e) {
        (,, e,,) = p.accounts(id);
    }
}
