// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Script, console} from "forge-std/Script.sol";
import {ZkWujiIndex, ISP1Verifier} from "../src/ZkWujiIndex.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {FeeRouter} from "../src/FeeRouter.sol";

/// T13, the mainnet shape on a testnet: a header-path-only ZkWujiIndex (no verifier, no challenge window) with
/// CONFIRMATIONS = 100, its own operations reserve (RelayerRewards) and a FeeRouter for consumers' fees, so
/// submitters are paid from fees like miners. RelayerRewards binds the index address before the index exists:
/// it is predicted from the deployer's nonce and checked by the index's constructor.
///
///   EXPECTED_CHAIN_ID=11155111 ANCHOR_JSON=deployments/sepolia-t13-anchor.json forge script \
///     script/DeployHeaderIndex.s.sol --rpc-url $RPC --account $ACCOUNT --password-file $PW --sender $DEPLOYER --broadcast
contract DeployHeaderIndex is Script {
    function run() external {
        require(block.chainid == vm.envUint("EXPECTED_CHAIN_ID"), "wrong chain");
        require(block.chainid == 11155111 || block.chainid == 97 || block.chainid == 31337, "testnets only until audited");
        string memory j = vm.readFile(vm.envString("ANCHOR_JSON"));
        bytes memory anchor = vm.parseJsonBytes(j, ".anchorHeader");
        uint64 height = uint64(vm.parseJsonUint(j, ".anchorHeight"));
        uint32 epochStart = uint32(vm.parseJsonUint(j, ".epochStart"));
        uint32[11] memory times;
        {
            uint256[] memory t = vm.parseJsonUintArray(j, ".ancestorTimes");
            require(t.length == 11, "11 ancestor times");
            for (uint256 i; i < 11; i++) times[i] = uint32(t[i]);
        }
        ZkWujiIndex.Schedule memory schedule =
            ZkWujiIndex.Schedule(height + 1, 4320, uint64(vm.envOr("CONFIRMATIONS", uint256(100))));
        address sender = msg.sender;

        vm.startBroadcast();
        address predicted = vm.computeCreateAddress(sender, vm.getNonce(sender) + 1);
        RelayerRewards rewards = new RelayerRewards(predicted, schedule.genesisHeight);
        ZkWujiIndex idx = new ZkWujiIndex(
            ISP1Verifier(address(0)), bytes32(0), rewards, anchor, height, epochStart, times, 0, schedule,
            ZkWujiIndex.Challenge(0, 0, 0)
        );
        FeeRouter router = new FeeRouter(rewards);
        vm.stopBroadcast();

        require(address(idx) == predicted, "index address prediction");
        require(rewards.index() == address(idx) && address(router.rewards()) == address(rewards), "binding");
        require(address(idx.verifier()) == address(0) && idx.CONFIRMATIONS() == schedule.confirmations, "shape");
        require(idx.lastHeight() == height && idx.committedAt(height) != bytes32(0) && !idx.frozen(), "state");
        console.log("RelayerRewards", address(rewards));
        console.log("ZkWujiIndex", address(idx));
        console.log("FeeRouter", address(router));
    }
}
