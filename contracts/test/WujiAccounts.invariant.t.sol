// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BitcoinRelay} from "../src/BitcoinRelay.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {WujiAccounts} from "../src/WujiAccounts.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";
import {FrozenExitRelayMock} from "./mocks/FrozenExitRelayMock.sol";

/// Random sequences of enter / exit / claim / retire / transfer / process / sweep / Bitcoin heights (including
/// the relay's best height moving down) by several actors, at a leverage high enough to reach floors often.
contract AccountsHandler is Test {
    WujiAccounts public pool;
    WujiIndex public idx;
    FrozenExitRelayMock public r;
    MockUSDT public token;
    address[] public actors;
    uint256[] public ids;
    uint256 public ghostDrops;
    uint256 public ghostFloors;
    uint256 public ghostClaims;
    uint256 public ghostProcessed;

    constructor(WujiAccounts p, WujiIndex i, FrozenExitRelayMock relay, MockUSDT t) {
        pool = p; idx = i; r = relay; token = t;
        for (uint256 k; k < 4; k++) {
            address a = address(uint160(0xA11CE + k));
            actors.push(a);
            token.mint(a, 1e30);
            vm.prank(a);
            token.approve(address(pool), type(uint256).max);
        }
    }

    function idCount() external view returns (uint256) { return ids.length; }

    function _entered(uint256 id) internal view returns (bool) {
        (,, uint64 e,,) = pool.accounts(id);
        (,, bool processed) = pool.epochAcc(e);
        return processed;
    }

    function enter(uint256 seed, bool yang, uint256 amount) external {
        amount = bound(amount, 0.5e18, 50e18);
        if (!pool.acceptingRequests()) return;
        vm.prank(actors[seed % actors.length]);
        ids.push(pool.requestEnter(yang, uint128(amount)));
    }

    function exit(uint256 idSeed) external {
        if (ids.length == 0 || !pool.acceptingRequests()) return;
        uint256 id = ids[idSeed % ids.length];
        (address owner,, uint64 enterEpoch, uint64 exitEpoch,) = pool.accounts(id);
        if (owner == address(0) || exitEpoch != 0 || !_entered(id)) return;
        if (pool.nextPricingHeight() <= enterEpoch) return;
        vm.prank(owner);
        pool.requestExit(id);
    }

    function claim(uint256 idSeed) external {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        (address owner,,, uint64 exitEpoch,) = pool.accounts(id);
        if (owner == address(0) || exitEpoch == 0) return;
        (,, bool processed) = pool.epochAcc(exitEpoch);
        if (!processed) return;
        vm.prank(owner);
        pool.claim(id);
        ghostClaims++;
    }

    function retire(uint256 idSeed) external {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        (address owner,,, uint64 exitEpoch,) = pool.accounts(id);
        if (owner == address(0) || exitEpoch != 0 || !_entered(id) || pool.valueOf(id) != 0) return;
        pool.retire(id);
        ghostFloors++;
    }

    function transfer(uint256 idSeed, uint256 toSeed) external {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        (address owner,,,,) = pool.accounts(id);
        if (owner == address(0)) return;
        vm.prank(owner);
        pool.transfer(id, actors[toSeed % actors.length]);
    }

    function process() external {
        ghostProcessed += pool.processMany(5);
    }

    function sweep() external {
        pool.sweep();
    }

    /// Mine and fold 1..30 heights.
    function mine(uint256 count) external {
        count = bound(count, 1, 30);
        uint64 end = idx.lastHeight() + uint64(count);
        for (uint64 h = idx.lastHeight() + 1; h <= end + 6; h++) r.put(h, keccak256(abi.encode(h, "inv")));
        r.tip(end + 6, keccak256(abi.encode(end + 6, "inv")), false);
        idx.fold(count);
    }

    /// The relay switches to a heavier but shorter branch that still contains the folded tip.
    function dropBest(uint256 by) external {
        uint64 best = r.bestHeight();
        uint64 floor = idx.lastHeight() + 1;
        if (best <= floor) return;
        uint64 d = uint64(bound(by, 1, best - floor));
        r.tip(best - d, r.headerAt(best - d), false);
        ghostDrops++;
    }
}

contract WujiAccountsInvariantTest is Test {
    AccountsHandler h;
    WujiAccounts pool;
    WujiIndex idx;
    FrozenExitRelayMock r;
    MockUSDT token;

    function setUp() public {
        vm.warp(1_800_000_000);
        r = new FrozenExitRelayMock();
        idx = new WujiIndex(BitcoinRelay(address(r)), 1000, 4320, RelayerRewards(address(0)));
        token = new MockUSDT();
        // K = 0.01: roughly 50% of principal per block, so floors, ceilings and overshoot happen within a run.
        pool = new WujiAccounts(WujiAccounts.Config(token, idx, 0.01e18, 6, 2, 30 minutes, address(0xFEE), 30, 10_000, 1_000));
        h = new AccountsHandler(pool, idx, r, token);
        h.mine(10);
        targetContract(address(h));
    }

    /// Every account's claim is covered, except losses past the floor that are either recorded as badDebt or
    /// belong to accounts nobody has retired yet. Pending entries are held in full; the buffer is on top.
    function invariant_solvent() public view {
        uint256 owed; uint256 unretired;
        for (uint256 i; i < h.idCount(); i++) {
            uint256 id = h.ids(i);
            (address owner,, uint64 enterEpoch,, uint128 principal) = pool.accounts(id);
            if (owner == address(0)) continue;
            (,, bool entered) = pool.epochAcc(enterEpoch);
            if (!entered) { owed += principal; continue; }
            owed += pool.valueOf(id);
            int256 raw = pool.rawValueOf(id);
            if (raw < 0) unretired += uint256(-raw);
        }
        assertGe(token.balanceOf(address(pool)) + pool.badDebt() + unretired, owed + pool.buffer());
    }

    /// Principal bookkeeping matches the accounts exactly.
    function invariant_principalBooks() public view {
        uint256 pending; uint256[2] memory live;
        for (uint256 i; i < h.idCount(); i++) {
            uint256 id = h.ids(i);
            (address owner, bool yang, uint64 enterEpoch, uint64 exitEpoch, uint128 principal) = pool.accounts(id);
            if (owner == address(0)) continue;
            (,, bool entered) = pool.epochAcc(enterEpoch);
            if (!entered) { pending += principal; continue; }
            bool exited;
            if (exitEpoch != 0) (,, exited) = pool.epochAcc(exitEpoch);
            if (!exited) live[yang ? 1 : 0] += principal;
        }
        assertEq(pool.pendingPrincipal(), pending, "pending");
        assertEq(pool.principalOf(0), live[0], "yin");
        assertEq(pool.principalOf(1), live[1], "yang");
    }

    /// The queue is strictly increasing and nothing is processed beyond the folded tip.
    function invariant_queue() public view {
        uint256 n = pool.queueLength();
        for (uint256 i = 1; i < n; i++) assertGt(pool.queue(i), pool.queue(i - 1));
        assertLe(pool.head(), n);
        if (pool.head() > 0) assertLe(pool.queue(pool.head() - 1), idx.lastHeight());
    }

    /// No open account's value leaves [0, 2·principal].
    function invariant_bounds() public view {
        for (uint256 i; i < h.idCount(); i++) {
            (address owner,,,, uint128 principal) = pool.accounts(h.ids(i));
            if (owner != address(0)) assertLe(pool.valueOf(h.ids(i)), 2 * uint256(principal));
        }
    }

    function invariant_callSummary() public view {
        // Keeps the run's shape visible with -vv; the assertions above carry the weight.
        h.ghostDrops(); h.ghostFloors(); h.ghostClaims(); h.ghostProcessed();
    }
}
