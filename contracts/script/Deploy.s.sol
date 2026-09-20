// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BitcoinRelay} from "../src/BitcoinRelay.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {WujiVault} from "../src/WujiVault.sol";
import {WujiVaultFactory} from "../src/WujiVaultFactory.sol";
import {SeriesTokenDeployer} from "../src/SeriesToken.sol";
import {MockUSDT} from "../test/mocks/MockUSDT.sol";
import {MockWBNB} from "../test/mocks/MockWBNB.sol";

/// Deploys WujiIndex (genesis = deploy block), WujiVaultFactory, and one vault per requested collateral.
///
///   EXPECTED_CHAIN_ID=56 TREASURY=<addr> VAULTS=<asset>:<notional>,<asset>:<notional> [SERIES_BLOCKS=5760000] \
///   forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --account $KEYSTORE_ACCOUNT --password-file $PASSWORD_FILE
///
/// Testnet (ALLOW_MOCK_ASSET=true, never on chain 56): with VAULTS unset, deploys MockUSDT (100/pair) and
/// MockWBNB (1/pair), mints test balances to the deployer, and opens both vaults.
contract Deploy is Script {
    function run() external {
        address treasury = vm.envOr("TREASURY", address(0));
        uint256 checkpointInterval = vm.envOr("CHECKPOINT_INTERVAL", uint256(4320));
        uint256 expectedChainId = vm.envOr("EXPECTED_CHAIN_ID", uint256(0));
        bool allowMockAsset = vm.envOr("ALLOW_MOCK_ASSET", false);
        string memory spec = vm.envOr("VAULTS", string(""));
        require(expectedChainId != 0 && block.chainid == expectedChainId, "wrong or missing EXPECTED_CHAIN_ID");
        require(!allowMockAsset || block.chainid != 56, "mock disabled on BSC mainnet");
        if (allowMockAsset && treasury == address(0)) treasury = msg.sender;
        require(treasury != address(0), "TREASURY required");
        require(checkpointInterval <= type(uint64).max, "SERIES_BLOCKS too large");

        vm.startBroadcast();
        BitcoinRelay relay = new BitcoinRelay(vm.envBytes("BTC_CHECKPOINT_HEADER"),uint64(vm.envUint("BTC_CHECKPOINT_HEIGHT")),uint32(vm.envUint("BTC_EPOCH_START_TIME")),vm.envUint("BTC_CHECKPOINT_WORK"));
        WujiIndex idx = new WujiIndex(relay,uint64(vm.envUint("GENESIS_HEIGHT")),uint64(checkpointInterval));
        console.log("BitcoinRelay:",address(relay));
        SeriesTokenDeployer tokens = new SeriesTokenDeployer();
        WujiVaultFactory factory = new WujiVaultFactory(idx, treasury, tokens);
        console.log("WujiIndex:", address(idx));
        console.log("SeriesTokenDeployer:", address(tokens));
        console.log("WujiVaultFactory:", address(factory));

        if (bytes(spec).length == 0) {
            require(allowMockAsset, "VAULTS required; mock disabled");
            MockUSDT usdt = new MockUSDT();
            usdt.mint(msg.sender, 1_000_000e18);
            MockWBNB wbnb = new MockWBNB();
            wbnb.mint(msg.sender, 10_000e18);
            console.log("MockUSDT:", address(usdt));
            console.log("MockWBNB:", address(wbnb));
            _create(factory, address(usdt), 100e18);
            _create(factory, address(wbnb), 1e18);
        } else {
            string[] memory items = vm.split(spec, ",");
            for (uint256 i = 0; i < items.length; i++) {
                string[] memory kv = vm.split(items[i], ":");
                require(kv.length == 2, "VAULTS format asset:notional");
                address asset = vm.parseAddress(kv[0]);
                require(asset.code.length > 0, "asset not contract");
                _create(factory, asset, vm.parseUint(kv[1]));
            }
        }
        vm.stopBroadcast();
        console.log("genesis block:", idx.GENESIS_HEIGHT());
        console.log("series blocks:", idx.CHECKPOINT_INTERVAL());
        console.log("chain id:", block.chainid);
        console.log("treasury:", treasury);
    }

    function _create(WujiVaultFactory factory, address asset, uint256 notional) internal {
        WujiVault v = factory.create(IERC20(asset), notional);
        console.log(string.concat("Vault ", v.collateralSymbol(), ":"), address(v));
    }
}
