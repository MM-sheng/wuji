// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ZkWujiIndex, ISP1Verifier} from "../src/ZkWujiIndex.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {SP1Verifier} from "../src/vendor/sp1/SP1VerifierGroth16.sol";

/// A real SP1 Groth16 proof of 100 real mainnet headers, checked by SP1's own v6.1.0 verifier contract.
/// Fixtures come from `zk/script`: `cargo run --release -- --headers 100 prove --mode groth16`
/// (vkey 0x005bcc55…e2e8, 2026-09-29; 217 s on a 14-core M-series laptop, 31 GB peak memory).
contract ZkWujiGroth16Test is Test {
    bytes32 constant VKEY = 0x005bcc55d50f7f92d73f3869b71be8ff0ec500bfd58b484517106e52b613e2e8;

    string meta;
    bytes headers;
    bytes proof;
    bytes journal;
    SP1Verifier verifier;

    function setUp() public {
        meta = vm.readFile("test/fixtures/bitcoin-timestamps.json");
        headers = vm.parseBytes(vm.readFile("test/fixtures/bitcoin-timestamps.hex"));
        proof = vm.parseBytes(vm.trim(vm.readFile("test/fixtures/zk-groth16-100.proof.hex")));
        journal = vm.parseBytes(vm.trim(vm.readFile("test/fixtures/zk-groth16-100.journal.hex")));
        verifier = new SP1Verifier();
        // The fixture journal was produced with maxTime = u32::MAX; the contract requires maxTime to be at
        // most two hours past "now", so run at the end of the u32 range.
        vm.warp(type(uint32).max);
    }

    function _deploy(ISP1Verifier v, bytes32 vkey) internal returns (ZkWujiIndex) {
        bytes memory anchor = vm.parseBytes(string.concat("0x", vm.parseJsonString(meta, ".checkpointHeader")));
        bytes memory ancestors = vm.parseBytes(vm.readFile("test/fixtures/bitcoin-timestamps-ancestors.hex"));
        uint32[11] memory times;
        for (uint256 i = 0; i < 11; i++) {
            bytes memory h = ancestors;
            uint256 at = i * 80 + 68;
            times[i] = uint32(uint8(h[at])) | uint32(uint8(h[at + 1])) << 8 | uint32(uint8(h[at + 2])) << 16
                | uint32(uint8(h[at + 3])) << 24;
        }
        return new ZkWujiIndex(
            v,
            vkey,
            RelayerRewards(address(0)),
            anchor,
            uint64(vm.parseJsonUint(meta, ".checkpointHeight")),
            uint32(vm.parseJsonUint(meta, ".epochStartTime")),
            times,
            0,
            ZkWujiIndex.Schedule(uint64(vm.parseJsonUint(meta, ".start")), 4320, 6),
            ZkWujiIndex.Challenge({window: 6 hours, responseWindow: 6 hours, bond: 0.05 ether})
        );
    }

    function _slice(uint256 count) internal view returns (bytes memory out) {
        out = new bytes(count * 80);
        for (uint256 i; i < out.length; i++) out[i] = headers[i];
    }

    function test_realGroth16ProofAdvancesTheIndexLikeTheHeaderPath() public {
        ZkWujiIndex viaProof = _deploy(ISP1Verifier(address(verifier)), VKEY);
        uint256 g = gasleft();
        viaProof.foldProof(proof, journal, new address[](0));
        uint256 used = g - gasleft();
        vm.warp(block.timestamp + 6 hours);
        g = gasleft();
        viaProof.finalize(1);
        uint256 finalizeGas = g - gasleft();

        ZkWujiIndex viaHeaders = _deploy(ISP1Verifier(address(verifier)), VKEY);
        vm.warp(1_800_000_000); // header path: a normal "now" (u32::MAX + 2h would overflow its bound)
        bytes memory raw = _slice(100); // built first: the test's byte-copy loop is not the contract's cost
        uint256 g2 = gasleft();
        viaHeaders.foldHeaders(raw, new address[](0));
        uint256 usedHeaders = g2 - gasleft();

        assertEq(viaProof.lastHeight(), viaHeaders.lastHeight(), "height");
        assertEq(viaProof.lastHash(), viaHeaders.lastHash(), "hash");
        assertEq(viaProof.S(), viaHeaders.S(), "S");
        assertEq(viaProof.chainWork(), viaHeaders.chainWork(), "work");

        console.log("foldProof, 100 headers (incl. Groth16 verify):", used);
        console.log("finalize, after the challenge window:         ", finalizeGas);
        console.log("foldHeaders, same 100 headers:               ", usedHeaders);
    }

    function test_verifierAloneGas() public view {
        uint256 g = gasleft();
        verifier.verifyProof(VKEY, journal, proof);
        console.log("SP1 Groth16 verifyProof alone:", g - gasleft());
    }

    function test_tamperedJournalIsRejected() public {
        ZkWujiIndex idx = _deploy(ISP1Verifier(address(verifier)), VKEY);
        bytes memory bad = journal;
        bad[bad.length - 1] = bytes1(uint8(bad[bad.length - 1]) ^ 1);
        vm.expectRevert();
        idx.foldProof(proof, bad, new address[](0));
    }

    function test_wrongProgramKeyIsRejected() public {
        ZkWujiIndex idx = _deploy(ISP1Verifier(address(verifier)), bytes32(uint256(VKEY) ^ 1));
        vm.expectRevert();
        idx.foldProof(proof, journal, new address[](0));
    }

    function test_tamperedProofIsRejected() public {
        ZkWujiIndex idx = _deploy(ISP1Verifier(address(verifier)), VKEY);
        bytes memory bad = proof;
        bad[100] = bytes1(uint8(bad[100]) ^ 1);
        vm.expectRevert();
        idx.foldProof(bad, journal, new address[](0));
    }
}
