// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WujiAccounts} from "../src/WujiAccounts.sol";

/// Simulation only (never broadcast): on a fork, approve and request an entry into POOL as SENDER.
contract AccountsForkCheck is Script {
    function run() external {
        WujiAccounts pool = WujiAccounts(vm.envAddress("POOL"));
        address sender = vm.envAddress("SENDER");
        vm.startPrank(sender);
        IERC20(address(pool.asset())).approve(address(pool), 1e18);
        uint256 id = pool.requestEnter(true, 1e18);
        vm.stopPrank();
        console.log("simulated account", id);
    }
}
