// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {WujiVault} from "../src/WujiVault.sol";

/// Deploys WujiIndex (genesis = next block) and WujiVault on top of it.
///   ASSET=<collateral erc20> TREASURY=<addr> [NOTIONAL=100000000000000000000] \
///   forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --private-key $PK
contract Deploy is Script {
    function run() external {
        address asset = vm.envAddress("ASSET");
        address treasury = vm.envAddress("TREASURY");
        uint256 notional = vm.envOr("NOTIONAL", uint256(100e18));
        vm.startBroadcast();
        WujiIndex idx = new WujiIndex(uint64(block.number));
        WujiVault vault = new WujiVault(IERC20(asset), idx, notional, treasury);
        vm.stopBroadcast();
        console.log("WujiIndex:", address(idx));
        console.log("WujiVault:", address(vault));
        console.log("genesis block:", idx.GENESIS_BLOCK());
    }
}
