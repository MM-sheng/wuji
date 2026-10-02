// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Script, console} from "forge-std/Script.sol";
import {ZkWujiIndex, ISP1Verifier} from "../src/ZkWujiIndex.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {SP1Verifier} from "../src/vendor/sp1/SP1VerifierGroth16.sol";

/// Local-only: SP1's real Groth16 verifier and a ZkWujiIndex anchored at the committed mainnet fixture,
/// for the zk-keeper end-to-end run. Never broadcast anywhere but anvil.
contract ZkFixture is Script {
    function run() external {
        require(block.chainid == 31337, "anvil only");
        string memory meta = vm.readFile("test/fixtures/bitcoin-timestamps.json");
        bytes memory anchor = vm.parseBytes(string.concat("0x", vm.parseJsonString(meta, ".checkpointHeader")));
        bytes memory anc = vm.parseBytes(vm.readFile("test/fixtures/bitcoin-timestamps-ancestors.hex"));
        uint32[11] memory times;
        for (uint256 i = 0; i < 11; i++) {
            uint256 at = i * 80 + 68;
            times[i] = uint32(uint8(anc[at])) | uint32(uint8(anc[at + 1])) << 8 | uint32(uint8(anc[at + 2])) << 16
                | uint32(uint8(anc[at + 3])) << 24;
        }
        ZkWujiIndex.Schedule memory schedule = ZkWujiIndex.Schedule(uint64(vm.parseJsonUint(meta, ".start")), 4320, 6);
        // short windows so a local run can finalize after an anvil time jump
        ZkWujiIndex.Challenge memory challenge = ZkWujiIndex.Challenge({
            window: uint64(vm.envOr("CHALLENGE_WINDOW", uint256(600))),
            responseWindow: uint64(vm.envOr("RESPONSE_WINDOW", uint256(600))),
            bond: vm.envOr("DISPUTE_BOND", uint256(0.01 ether))
        });
        uint64 anchorHeight = uint64(vm.parseJsonUint(meta, ".checkpointHeight"));
        uint32 epochStart = uint32(vm.parseJsonUint(meta, ".epochStartTime"));
        vm.startBroadcast();
        SP1Verifier verifier = new SP1Verifier();
        ZkWujiIndex idx = new ZkWujiIndex(
            ISP1Verifier(address(verifier)),
            0x005bcc55d50f7f92d73f3869b71be8ff0ec500bfd58b484517106e52b613e2e8,
            RelayerRewards(address(0)),
            anchor,
            anchorHeight,
            epochStart,
            times,
            0,
            schedule,
            challenge
        );
        vm.stopBroadcast();
        console.log("ZK_INDEX", address(idx));
    }
}
