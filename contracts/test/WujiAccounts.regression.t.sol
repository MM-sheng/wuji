// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {console} from "forge-std/Test.sol";
import {WujiAccountsFreezeInvariantTest} from "./WujiAccounts.invariant.t.sol";
/// Shrunk sequences the invariant suites found, replayed exactly. (The inherited invariants also run.)
contract WujiAccountsRegression is WujiAccountsFreezeInvariantTest {
    function _log(string memory at) internal view {
        console.log(at);
        console.log("  balance", token.balanceOf(address(pool)), "buffer", pool.buffer());
        console.log("  yin", pool.principalOf(0), "yang", pool.principalOf(1));
        console.log("  open", pool.openAccounts(), "frozen", pool.frozen() ? 1 : 0);
        console.log("  badDebt", pool.badDebt());
    }
    /// Unequal sides, one large move floors the small side past 0, then a freeze: the winner's value includes
    /// the loser's unpaid overshoot and drains the pool, buffer included. The buffer counter must follow the
    /// real balance, or the next sweep/bounty reverts and bricks the pool.
    function test_regression_overshootDrainsBufferThenSweep() public {
        h.enter(100, false, 832); h.enter(859783377551659, true, 1); _log("entered");
        h.mine(5700); h.process(); _log("priced");
        for (uint256 i = 1; i <= 2; i++) { console.log("  value", i, pool.valueOf(i)); console.logInt(pool.rawValueOf(i)); }
        h.freeze(16); h.process(); _log("frozen");
        for (uint256 i = 1; i <= 2; i++) { console.log("  value", i, pool.valueOf(i)); console.logInt(pool.rawValueOf(i)); }
        h.claim(23000000000000000000); _log("claimed");
        h.sweep(); _log("swept");
        assertLe(pool.buffer(), token.balanceOf(address(pool)));
    }
}
