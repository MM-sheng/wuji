// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {WujiVault} from "../src/WujiVault.sol";
import {MockUSDT} from "../test/mocks/MockUSDT.sol";

/// Deploys WujiIndex (genesis = deploy block) and WujiVault on top of it.
///   ASSET=<collateral erc20> TREASURY=<addr> [NOTIONAL=100000000000000000000] \
///   forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --private-key $PK
/// Testnet: leave ASSET unset and a MockUSDT is deployed and 1,000,000 minted to the deployer.
contract Deploy is Script {
    function run() external {
        address asset = vm.envOr("ASSET", address(0));
        address treasury = vm.envOr("TREASURY", msg.sender);
        uint256 notional = vm.envOr("NOTIONAL", uint256(100e18));
        vm.startBroadcast();
        if (asset == address(0)) {
            MockUSDT m = new MockUSDT();
            m.mint(msg.sender, 1_000_000e18);
            asset = address(m);
            console.log("MockUSDT:", asset);
        }
        WujiIndex idx = new WujiIndex(uint64(block.number));
        WujiVault vault = new WujiVault(IERC20(asset), idx, notional, treasury);
        vm.stopBroadcast();
        console.log("WujiIndex:", address(idx));
        console.log("WujiVault:", address(vault));
        console.log("genesis block:", idx.GENESIS_BLOCK());
    }
}
