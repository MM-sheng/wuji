// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {BitcoinRelay} from "../src/BitcoinRelay.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {WujiVault} from "../src/WujiVault.sol";
import {WujiVaultFactory} from "../src/WujiVaultFactory.sol";
import {SeriesTokenDeployer} from "../src/SeriesToken.sol";
import {MockUSDT} from "../test/mocks/MockUSDT.sol";
import {MockWBNB} from "../test/mocks/MockWBNB.sol";

/// Deploys reward sources with predicted CREATE addresses, an immutable router, and collateral vaults.
///
///   EXPECTED_CHAIN_ID=56 DEPLOYER=<addr> VAULTS=<asset>:<notional>,<asset>:<notional> [CHECKPOINT_INTERVAL=4320] \
///   forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --account $KEYSTORE_ACCOUNT --password-file $PASSWORD_FILE
///
/// Testnet (ALLOW_MOCK_ASSET=true, never on chain 56): with VAULTS unset, deploys MockUSDT (100/pair) and
/// MockWBNB (1/pair), mints test balances to the deployer, and opens both vaults.
contract Deploy is Script {
    function run() external {
        address deployer = vm.envAddress("DEPLOYER");
        uint256 checkpointInterval = vm.envOr("CHECKPOINT_INTERVAL", uint256(4320));
        uint256 expectedChainId = vm.envOr("EXPECTED_CHAIN_ID", uint256(0));
        bool allowMockAsset = vm.envOr("ALLOW_MOCK_ASSET", false);
        string memory spec = vm.envOr("VAULTS", string(""));
        require(expectedChainId != 0 && block.chainid == expectedChainId, "wrong or missing EXPECTED_CHAIN_ID");
        require(!allowMockAsset || block.chainid != 56, "mock disabled on BSC mainnet");

        require(checkpointInterval <= type(uint64).max, "CHECKPOINT_INTERVAL too large");

        vm.startBroadcast(deployer);
        (WujiIndex idx, WujiVaultFactory factory, address treasury) = _protocol(deployer, uint64(checkpointInterval));

        if (bytes(spec).length == 0) {
            require(allowMockAsset, "VAULTS required; mock disabled");
            MockUSDT usdt = new MockUSDT();
            usdt.mint(deployer, 1_000_000e18);
            MockWBNB wbnb = new MockWBNB();
            wbnb.mint(deployer, 10_000e18);
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
        console.log("genesis height:", idx.GENESIS_HEIGHT());
        console.log("series heights:", idx.CHECKPOINT_INTERVAL());
        console.log("chain id:", block.chainid);
        console.log("treasury:", treasury);
    }


    function _protocol(address deployer, uint64 checkpointInterval) internal returns(WujiIndex idx, WujiVaultFactory factory, address treasury) {
        uint64 nonce = vm.getNonce(deployer);
        address predictedRelay = vm.computeCreateAddress(deployer, nonce + 1);
        address predictedIndex = vm.computeCreateAddress(deployer, nonce + 2);
        uint256 genesis = vm.envUint("GENESIS_HEIGHT");
        require(genesis <= type(uint64).max, "genesis overflow");
        RelayerRewards rewards = new RelayerRewards(predictedIndex, uint64(genesis));
        BitcoinRelay relay = new BitcoinRelay(vm.envBytes("BTC_CHECKPOINT_HEADER"),uint64(vm.envUint("BTC_CHECKPOINT_HEIGHT")),uint32(vm.envUint("BTC_EPOCH_START_TIME")),vm.envUint("BTC_CHECKPOINT_WORK"));
        idx = new WujiIndex(relay,uint64(genesis),checkpointInterval, rewards);
        require(address(relay) == predictedRelay && address(idx) == predictedIndex, "CREATE nonce mismatch");
        FeeRouter router = new FeeRouter(rewards);
        treasury = address(router);
        console.log("RelayerRewards:", address(rewards));
        console.log("FeeRouter:", address(router));
        console.log("BitcoinRelay:",address(relay));
        SeriesTokenDeployer tokens = new SeriesTokenDeployer();
        factory = new WujiVaultFactory(idx, treasury, tokens);
        console.log("WujiIndex:", address(idx));
        console.log("SeriesTokenDeployer:", address(tokens));
        console.log("WujiVaultFactory:", address(factory));

    }

    function _create(WujiVaultFactory factory, address asset, uint256 notional) internal {
        WujiVault v = factory.create(IERC20(asset), notional);
        console.log(string.concat("Vault ", v.collateralSymbol(), ":"), address(v));
    }
}
