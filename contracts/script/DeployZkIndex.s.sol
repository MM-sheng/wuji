// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Script, console} from "forge-std/Script.sol";
import {ZkWujiIndex, ISP1Verifier} from "../src/ZkWujiIndex.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {SP1Verifier} from "../src/vendor/sp1/SP1VerifierGroth16.sol";

/// T10 on a public testnet: SP1's Groth16 verifier (v6.1.0, unmodified) and a ZkWujiIndex anchored at a real
/// Bitcoin header. Anchor data comes from ANCHOR_JSON (fetched from two independent Bitcoin sources).
///
///   EXPECTED_CHAIN_ID=11155111 ANCHOR_JSON=/path/anchor.json forge script script/DeployZkIndex.s.sol ...
contract DeployZkIndex is Script {
    bytes32 constant VKEY = 0x005bcc55d50f7f92d73f3869b71be8ff0ec500bfd58b484517106e52b613e2e8;

    function run() external {
        require(block.chainid == vm.envUint("EXPECTED_CHAIN_ID"), "wrong chain");
        require(block.chainid == 11155111 || block.chainid == 97, "testnets only until audited");
        string memory j = vm.readFile(vm.envString("ANCHOR_JSON"));
        bytes memory anchor = vm.parseJsonBytes(j, ".anchorHeader");
        uint64 height = uint64(vm.parseJsonUint(j, ".anchorHeight"));
        uint32 epochStart = uint32(vm.parseJsonUint(j, ".epochStart"));
        uint256[] memory t = vm.parseJsonUintArray(j, ".ancestorTimes");
        require(t.length == 11, "11 ancestor times");
        uint32[11] memory times;
        for (uint256 i; i < 11; i++) times[i] = uint32(t[i]);
        require(times[10] == uint32(uint8(anchor[68])) | uint32(uint8(anchor[69])) << 8
            | uint32(uint8(anchor[70])) << 16 | uint32(uint8(anchor[71])) << 24, "last ancestor time is the anchor's");

        vm.startBroadcast();
        SP1Verifier verifier = new SP1Verifier();
        ZkWujiIndex idx = new ZkWujiIndex(
            ISP1Verifier(address(verifier)), VKEY, RelayerRewards(address(0)), anchor, height, epochStart, times, 0,
            height + 1, 4320
        );
        vm.stopBroadcast();

        // Read back what was deployed.
        (ZkWujiIndex.Continuity memory c,,) = idx.continuity();
        require(c.height == height && c.epochStart == epochStart && c.u == 0, "continuity");
        require(idx.programVKey() == VKEY && address(idx.verifier()) == address(verifier), "binding");
        require(keccak256(bytes(verifier.VERSION())) == keccak256("v6.1.0"), "verifier version");
        console.log("SP1Verifier", address(verifier));
        console.log("ZkWujiIndex", address(idx));
        console.logBytes32(c.hash);
    }
}
