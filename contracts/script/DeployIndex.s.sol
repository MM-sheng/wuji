// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {WujiIndex} from "../src/WujiIndex.sol";

/// Deploys WujiIndex with genesis = the block right after deployment (so nothing is ever frozen at birth).
///   forge script script/DeployIndex.s.sol --rpc-url $RPC --broadcast --private-key $PK
/// Override the genesis block with GENESIS_BLOCK=<n> (must be within 255 blocks of the deploy block).
contract DeployIndex is Script {
    function run() external {
        uint64 genesis = uint64(vm.envOr("GENESIS_BLOCK", block.number + 1));
        vm.startBroadcast();
        WujiIndex idx = new WujiIndex(genesis);
        vm.stopBroadcast();
        console.log("WujiIndex:", address(idx));
        console.log("genesis block:", genesis);
    }
}
