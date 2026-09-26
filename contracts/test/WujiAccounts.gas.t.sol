// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test, console} from "forge-std/Test.sol";
import {BitcoinRelay} from "../src/BitcoinRelay.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {WujiAccounts} from "../src/WujiAccounts.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";
import {FrozenExitRelayMock} from "./mocks/FrozenExitRelayMock.sol";

/// Gas of each user and keeper operation, warm pool, deployed parameters (fee 30 bps, epoch 6, delay 16).
/// Run: forge test --match-contract WujiAccountsGas -vv
contract WujiAccountsGas is Test {
    FrozenExitRelayMock r; WujiIndex idx; WujiAccounts pool; MockUSDT t;
    address a = address(0xA11CE); address b = address(0xB0B);

    function setUp() public {
        vm.warp(1_800_000_000);
        r = new FrozenExitRelayMock();
        idx = new WujiIndex(BitcoinRelay(address(r)), 1000, 4320, RelayerRewards(address(0)));
        t = new MockUSDT();
        pool = new WujiAccounts(WujiAccounts.Config(t, idx, 11.5e18, 6, 16, 30 minutes, address(0xFEE), 30, 0.0001e18, 1_000));
        for (uint256 i; i < 2; i++) { address u = i == 0 ? a : b; t.mint(u, 1e24); vm.prank(u); t.approve(address(pool), type(uint256).max); }
        _mine(10);
    }

    function _mine(uint64 count) internal {
        uint64 end = idx.lastHeight() + count;
        for (uint64 h = idx.lastHeight() + 1; h <= end + 6; h++) r.put(h, keccak256(abi.encode(h, "gas")));
        r.tip(end + 6, keccak256(abi.encode(end + 6, "gas")), false);
        idx.fold(256);
    }

    function _processAfterWalk(uint64 walk) internal returns (uint256 used) {
        (,, uint64 e,,) = pool.accounts(pool.nextId() - 1);
        used = _processAt(e, walk);
    }

    function _processAt(uint64 e, uint64 walk) internal returns (uint256 used) {
        if (idx.lastHeight() < e + walk) _mine(e + walk - idx.lastHeight());
        uint256 g = gasleft(); pool.processMany(1); used = g - gasleft();
    }

    function test_gas() public {
        uint256 g;
        vm.prank(a); g = gasleft(); pool.requestEnter(true, 10e18); console.log("requestEnter, new epoch   ", g - gasleft());
        vm.prank(b); g = gasleft(); pool.requestEnter(false, 10e18); console.log("requestEnter, same epoch  ", g - gasleft());
        console.log("process, walk 1 height    ", _processAfterWalk(1));
        vm.prank(a); pool.requestEnter(true, 1e18);
        console.log("process, walk 12 heights  ", _processAfterWalk(12));
        vm.prank(a); pool.requestEnter(true, 1e18);
        console.log("process, walk 144 heights ", _processAfterWalk(144));
        vm.prank(a); g = gasleft(); pool.requestExit(1); console.log("requestExit               ", g - gasleft());
        (,,, uint64 ex,) = pool.accounts(1);
        _processAt(ex, 1);
        vm.prank(a); g = gasleft(); pool.claim(1); console.log("claim                     ", g - gasleft());
        g = gasleft(); pool.sweep(); console.log("sweep                     ", g - gasleft());
        vm.prank(b); g = gasleft(); pool.transfer(2, a); console.log("transfer                  ", g - gasleft());
    }
}
