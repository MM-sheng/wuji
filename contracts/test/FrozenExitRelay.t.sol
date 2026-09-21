// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {EasyRelay} from "./BitcoinRelay.t.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {WujiVault} from "../src/WujiVault.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {SeriesTokenDeployer} from "../src/SeriesToken.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";

/// Real relay fork-choice/revision/state-machine integration, using explicitly easy test-only PoW.
/// Production mainnet PoW and retargets remain covered by the unchanged 6060-header suites.
contract FrozenExitRelayTest is Test {
    EasyRelay r;
    WujiIndex idx;
    bytes cp;
    bytes32 root;
    bytes32 originalTip;

    function setUp() public {
        string memory meta = vm.readFile("test/fixtures/bitcoin.json");
        cp = vm.parseBytes(string.concat("0x", vm.parseJsonString(meta, ".checkpointHeader")));
        bytes memory ancestors = vm.parseBytes(vm.readFile("test/fixtures/bitcoin-timestamps-ancestors.hex"));
        uint32 time;
        for (uint256 k; k < 4; ++k) {
            time |= uint32(uint8(cp[68 + k])) << uint32(8 * k);
        }
        vm.warp(time);
        r = new EasyRelay(cp, ancestors);
        root = r.bestHash();
        originalTip = extend(root, 10, 1);
        idx = new WujiIndex(r, 1001, 4320, RelayerRewards(address(0)));
        idx.fold();
        assertEq(idx.lastHeight(), 1004);
        assertEq(r.reorgCount(), 0);
    }

    function next(bytes32 parent, uint256 salt) internal view returns (bytes memory h) {
        h = new bytes(80);
        for (uint256 k; k < 32; ++k) {
            h[4 + k] = parent[k];
        }
        uint32 time = r.timestampOf(parent) + 1;
        for (uint256 k; k < 4; ++k) {
            h[68 + k] = bytes1(uint8(time >> (8 * k)));
            h[72 + k] = cp[72 + k];
        }
        for (uint256 nonce;; ++nonce) {
            bytes32 merkle = keccak256(abi.encode(salt, nonce));
            for (uint256 k; k < 32; ++k) {
                h[36 + k] = merkle[k];
            }
            if (uint256(r.reverse(sha256(abi.encodePacked(sha256(h))))) <= type(uint256).max / 2) return h;
        }
    }

    function extend(bytes32 parent, uint256 count, uint256 salt) internal returns (bytes32 hash) {
        hash = parent;
        for (uint256 k; k < count; ++k) {
            bytes memory h = next(hash, salt + k);
            uint256 time = r.timestampOf(hash) + 1;
            if (time > block.timestamp) vm.warp(time);
            r.submit(h);
            hash = sha256(abi.encodePacked(sha256(h)));
        }
    }

    function test_realForkDelayClosureAndAtomicRollback() public {
        MockUSDT asset = new MockUSDT();
        WujiVault vault = new WujiVault(asset, idx, 100e18, address(0xFEE), new SeriesTokenDeployer());
        asset.mint(address(this), 101e18);
        asset.approve(address(vault), type(uint256).max);
        vault.mint(1e18);
        bytes32 forkTip = extend(root, 11, 100);
        assertEq(r.reorgCount(), 1);
        vm.expectRevert("deep Bitcoin reorg");
        idx.fold();
        uint64 deadline = idx.observeReorg();
        assertEq(deadline, 1011 + 144);
        forkTip = extend(forkTip, 143, 200);
        assertFalse(idx.frozenExitReady());
        forkTip = extend(forkTip, 1, 500);
        assertTrue(idx.frozenExitReady());
        vm.prank(address(0xB0B));
        idx.freeze();
        vault.settleFrozen();
        assertEq(vault.yangShare(), 5e17);
        bytes memory h = next(forkTip, 600);
        uint64 beforeH = r.bestHeight();
        vm.expectRevert("index frozen");
        idx.submitAndFold(h, 1, new address[](0));
        assertEq(r.bestHeight(), beforeH);
        assertEq(r.bestHash(), forkTip);
        r.submit(h); // Standalone relay remains usable.
        assertEq(r.bestHeight(), beforeH + 1);
        vault.redeemSettled(0, 1e18, 1e18);
        assertEq(vault.liabilities(), 0);
    }

    function test_realUnobservedRestorationAndReturnInvalidatesPriorNotice() public {
        bytes32 forkTip = extend(root, 11, 100);
        uint64 oldDeadline = idx.observeReorg();
        extend(originalTip, 2, 300);
        assertTrue(idx.historyConsistent());
        assertEq(r.reorgCount(), 2);
        forkTip = extend(forkTip, 2, 400);
        assertFalse(idx.historyConsistent());
        assertEq(r.reorgCount(), 3);
        extend(forkTip, oldDeadline - r.bestHeight(), 500);
        assertFalse(idx.frozenExitReady());
        assertEq(idx.observeReorg(), r.bestHeight() + 144);
    }

    function test_realLosingForkDoesNotResetNotice() public {
        bytes32 forkTip = extend(root, 11, 100);
        uint64 deadline = idx.observeReorg();
        extend(root, 1, 900);
        assertEq(r.reorgCount(), 1);
        extend(forkTip, 144, 200);
        assertEq(idx.observeReorg(), deadline);
        assertTrue(idx.frozenExitReady());
    }
}
