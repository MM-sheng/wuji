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
        address treasury = vm.envOr("TREASURY", address(0));
        uint256 notional = vm.envOr("NOTIONAL", uint256(100e18));
        uint256 checkpointInterval = vm.envOr("SERIES_BLOCKS", uint256(5_760_000));
        uint256 expectedChainId = vm.envOr("EXPECTED_CHAIN_ID", uint256(0));
        bool allowMockAsset = vm.envOr("ALLOW_MOCK_ASSET", false);
        require(expectedChainId != 0 && block.chainid == expectedChainId, "wrong or missing EXPECTED_CHAIN_ID");
        require(!allowMockAsset || block.chainid != 56, "mock disabled on BSC mainnet");
        if (allowMockAsset && treasury == address(0)) treasury = msg.sender;
        require(treasury != address(0), "TREASURY required");
        require(checkpointInterval <= type(uint64).max, "SERIES_BLOCKS too large");
        if (asset != address(0)) require(asset.code.length > 0, "ASSET not contract");
        vm.startBroadcast();
        if (asset == address(0)) {
            require(allowMockAsset, "ASSET required; mock disabled");
            MockUSDT m = new MockUSDT();
            m.mint(msg.sender, 1_000_000e18);
            asset = address(m);
            console.log("MockUSDT:", asset);
        }
        WujiIndex idx = new WujiIndex(uint64(block.number), uint64(checkpointInterval));
        WujiVault vault = new WujiVault(IERC20(asset), idx, notional, treasury);
        vm.stopBroadcast();
        console.log("WujiIndex:", address(idx));
        console.log("WujiVault:", address(vault));
        console.log("genesis block:", idx.GENESIS_BLOCK());
        console.log("series blocks:", idx.CHECKPOINT_INTERVAL());
        console.log("chain id:", block.chainid);
        console.log("treasury:", treasury);
    }
}
