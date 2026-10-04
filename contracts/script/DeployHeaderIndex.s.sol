// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Script, console} from "forge-std/Script.sol";
import {WujiHeaderIndex} from "../src/WujiHeaderIndex.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {FeeRouter} from "../src/FeeRouter.sol";

/// T13, the mainnet shape (Ethereum mainnet or a testnet): WujiHeaderIndex (three rules, no proof path) with CONFIRMATIONS = 100, its own operations reserve (RelayerRewards) and a FeeRouter for consumers' fees, so
/// submitters are paid from fees like miners. RelayerRewards binds the index address before the index exists:
/// it is predicted from the deployer's nonce and checked by the index's constructor.
///
///   EXPECTED_CHAIN_ID=11155111 ANCHOR_JSON=deployments/sepolia-t13-anchor.json forge script \
///     script/DeployHeaderIndex.s.sol --rpc-url $RPC --account $ACCOUNT --password-file $PW --sender $DEPLOYER --broadcast
contract DeployHeaderIndex is Script {
    function run() external {
        require(block.chainid == vm.envUint("EXPECTED_CHAIN_ID"), "wrong chain");
        // Ethereum mainnet is allowed for the index, reserve and router only (2026-10-04 decision: they hold no user
        // funds; the pools stay testnet-only in DeployAccounts.s.sol until audited).
        require(
            block.chainid == 1 || block.chainid == 11155111 || block.chainid == 97 || block.chainid == 31337,
            "unsupported chain"
        );
        string memory j = vm.readFile(vm.envString("ANCHOR_JSON"));
        bytes memory anchor = vm.parseJsonBytes(j, ".anchorHeader");
        uint64 height = uint64(vm.parseJsonUint(j, ".anchorHeight"));
        uint32 epochStart = uint32(vm.parseJsonUint(j, ".epochStart"));
        uint32[11] memory times;
        {
            uint256[] memory t = vm.parseJsonUintArray(j, ".ancestorTimes");
            require(t.length == 11, "11 ancestor times");
            for (uint256 i; i < 11; i++) {
                times[i] = uint32(t[i]);
            }
        }
        uint64 confirmations = uint64(vm.envOr("CONFIRMATIONS", uint256(100)));
        require(block.chainid != 1 || confirmations == 100, "mainnet: CONFIRMATIONS is 100");
        address sender = msg.sender;

        vm.startBroadcast();
        address predicted = vm.computeCreateAddress(sender, vm.getNonce(sender) + 1);
        RelayerRewards rewards = new RelayerRewards(predicted, height + 1);
        WujiHeaderIndex idx =
            new WujiHeaderIndex(rewards, anchor, height, epochStart, times, 0, height + 1, 4320, confirmations);
        FeeRouter router = new FeeRouter(rewards);
        vm.stopBroadcast();

        require(address(idx) == predicted, "index address prediction");
        require(rewards.index() == address(idx) && address(router.rewards()) == address(rewards), "binding");
        require(idx.CONFIRMATIONS() == confirmations, "shape");
        require(idx.lastHeight() == height && idx.committedAt(height) != bytes32(0) && !idx.frozen(), "state");
        console.log("RelayerRewards", address(rewards));
        console.log("WujiHeaderIndex", address(idx));
        console.log("FeeRouter", address(router));
    }
}
