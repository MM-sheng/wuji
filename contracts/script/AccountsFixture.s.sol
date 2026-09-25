// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Script, console} from "forge-std/Script.sol";
import {BitcoinRelay} from "../src/BitcoinRelay.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {WujiAccounts} from "../src/WujiAccounts.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {MockUSDT} from "../test/mocks/MockUSDT.sol";
import {FrozenExitRelayMock} from "../test/mocks/FrozenExitRelayMock.sol";

/// Local-only fixture for indexer/accounts.integration.test.mjs: a real pool with one processed epoch
/// and one pending, on anvil. Never broadcast anywhere else.
contract AccountsFixture is Script {
    function run() external {
        require(block.chainid == 31337, "anvil only");
        vm.startBroadcast();
        FrozenExitRelayMock r = new FrozenExitRelayMock();
        WujiIndex idx = new WujiIndex(BitcoinRelay(address(r)), 1000, 4320, RelayerRewards(address(0)));
        MockUSDT token = new MockUSDT();
        WujiAccounts pool = new WujiAccounts(WujiAccounts.Config(token, idx, 11.5e18, 6, 2, 30 minutes, address(0xFEE), 30, 0.01e18, 1_000));
        token.mint(msg.sender, 1_000e18);
        token.approve(address(pool), type(uint256).max);
        _advance(r, idx, 1000, 1010);
        pool.requestEnter(true, 100e18);
        pool.requestEnter(false, 60e18);
        _advance(r, idx, 1011, 1030);
        pool.processMany(8);
        pool.requestEnter(false, 10e18); // pending
        vm.stopBroadcast();
        console.log("POOL", address(pool));
    }

    function _advance(FrozenExitRelayMock r, WujiIndex idx, uint64 from, uint64 to) internal {
        for (uint64 h = from; h <= to + 6; h++) r.put(h, keccak256(abi.encode(h, "fixture")));
        r.tip(to + 6, keccak256(abi.encode(to + 6, "fixture")), false);
        idx.fold(256);
    }
}
