// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {BitcoinRelay} from "../src/BitcoinRelay.sol";
import {WujiAccounts} from "../src/WujiAccounts.sol";
import {WujiAccountsFactory} from "../src/WujiAccountsFactory.sol";

/// T11: a factory bound to an existing WujiIndex and the three tier pools for one collateral.
///
///   EXPECTED_CHAIN_ID=97 INDEX=<WujiIndex> TREASURY=<FeeRouter> ASSET=<token> \
///   forge script script/DeployAccounts.s.sol --rpc-url $RPC --broadcast --account $KEYSTORE_ACCOUNT --password-file $PASSWORD_FILE
///
/// Pricing: epochs of 6 heights, DELAY 16, MAX_TIP_AGE 30 min (docs/tasks/T11 §Entry and exit timing).
/// INDEX may also be an index without a relay (ZkWujiIndex): the pools then price from its newest validated
/// header, which must be under 24 h old for the probe below to pass (fold first if it is not).
contract DeployAccounts is Script {
    function run() external {
        uint256 expected = vm.envUint("EXPECTED_CHAIN_ID");
        require(block.chainid == expected, "wrong chain");
        require(block.chainid == 97 || block.chainid == 11155111, "testnets only until audited");
        WujiIndex index = WujiIndex(vm.envAddress("INDEX"));
        address treasury = vm.envAddress("TREASURY");
        IERC20 asset = IERC20(vm.envAddress("ASSET"));
        bool hasRelay;
        try index.relay() returns (BitcoinRelay r) { hasRelay = address(r).code.length > 0; } catch {}
        require(address(index).code.length > 0 && treasury.code.length > 0, "bad index or treasury");

        vm.startBroadcast();
        WujiAccountsFactory factory = new WujiAccountsFactory(index, treasury, 6, 16, 30 minutes, 30, 1_000);
        WujiAccounts[3] memory pools;
        for (uint256 t; t < 3; t++) pools[t] = factory.create(asset, t); // one tx each: EIP-7825 gas cap
        vm.stopBroadcast();
        // Deployment alone proves nothing about requests: probe the exact request conditions now.
        for (uint256 t; t < 3; t++) {
            require(pools[t].RELAY_TIP() == hasRelay, "pricing mode");
            require(pools[t].acceptingRequests(), "pool would reject requests");
        }
        console.log("WujiAccountsFactory", address(factory));
        for (uint256 t; t < 3; t++) console.log("pool", t, address(pools[t]));
    }
}
