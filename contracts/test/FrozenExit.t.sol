// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {BitcoinRelay} from "../src/BitcoinRelay.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {WujiVault} from "../src/WujiVault.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {SeriesToken, SeriesTokenDeployer} from "../src/SeriesToken.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";
import {FrozenExitRelayMock} from "./mocks/FrozenExitRelayMock.sol";

contract FrozenExitTest is Test {
    FrozenExitRelayMock r;
    WujiIndex idx;
    WujiVault vault;
    MockUSDT asset;
    SeriesTokenDeployer deployer;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address treasury = address(0xFEE);
    uint256 constant N = 100e18;

    function setUp() public {
        vm.warp(1_800_000_000);
        r = new FrozenExitRelayMock();
        idx = new WujiIndex(BitcoinRelay(address(r)), 1000, 20, RelayerRewards(address(0)));
        asset = new MockUSDT();
        deployer = new SeriesTokenDeployer();
        vault = makeVault();
        asset.mint(alice, 1_000_000e18);
        asset.mint(bob, 1_000_000e18);
        vm.prank(alice);
        asset.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        asset.approve(address(vault), type(uint256).max);
    }

    function makeVault() internal returns (WujiVault) {
        return new WujiVault(asset, idx, N, treasury, deployer);
    }

    function advance(uint64 count) internal {
        uint64 end = idx.lastHeight() + count;
        for (uint64 h = idx.lastHeight() + 1; h <= end; h++) {
            r.put(h, keccak256(abi.encode(h, "history")));
        }
        extend(end + 6);
        idx.fold(count);
    }

    function extend(uint64 h) internal {
        r.tip(h, keccak256(abi.encode(h, "tip")), false);
    }

    function fork() internal returns (uint64 deadline) {
        r.put(idx.lastHeight(), keccak256("replacement"));
        r.tip(r.bestHeight() + 1, keccak256("fork tip"), true);
        deadline = idx.observeReorg();
    }

    function seal() internal {
        uint64 deadline = fork();
        extend(deadline);
        idx.freeze();
    }

    function tokens(WujiVault v, uint256 id) internal view returns (SeriesToken y, SeriesToken n) {
        (y, n,,,,,) = v.series(id);
    }

    function share(int256 s0, int256 s1) internal pure returns (uint256) {
        int256 value = int256(5e17) + (s1 - s0) / 2;
        return value <= 0 ? 0 : value >= 1e18 ? 1e18 : uint256(value);
    }

    function test_emptyHealthyAndStaleHistoryCannotArmExit() public {
        vm.expectRevert("history consistent");
        idx.observeReorg();
        advance(4);
        r.setStale(true);
        extend(r.bestHeight() + 1000);
        vm.expectRevert("relay stale");
        idx.fold();
        vm.expectRevert("history consistent");
        idx.observeReorg();
        vm.expectRevert("frozen exit not ready");
        idx.freeze();
        vm.expectRevert("index not frozen");
        vault.settleFrozen();
    }

    function test_noNoticeMeansNoExitAndRevertedFoldDoesNotRecordOne() public {
        advance(4);
        r.put(idx.lastHeight(), keccak256("fork"));
        extend(r.bestHeight() + 1000);
        vm.expectRevert("deep Bitcoin reorg");
        idx.fold(0);
        (uint64 from,,,,,) = idx.reorgNotice();
        assertEq(from, 0);
        assertFalse(idx.frozenExitReady());
        vm.expectRevert("frozen exit not ready");
        idx.freeze();
    }

    function test_repeatNoticeDoesNotResetAndClockDoesNotAdvanceDelay() public {
        advance(4);
        uint64 deadline = fork();
        extend(deadline - 1);
        vm.warp(block.timestamp + 365 days);
        assertEq(idx.observeReorg(), deadline);
        assertFalse(idx.frozenExitReady());
        vm.expectRevert("frozen exit not ready");
        idx.freeze();
        extend(deadline);
        assertTrue(idx.frozenExitReady());
        idx.freeze();
        assertTrue(idx.frozen());
    }

    function test_recoveryBeforeExitResumesAndInvalidatesNotice() public {
        advance(4);
        uint64 deadline = fork();
        r.put(idx.lastHeight(), idx.lastHash());
        r.tip(deadline, keccak256("restored"), true);
        assertFalse(idx.frozenExitReady());
        assertTrue(idx.historyConsistent());
        vm.expectRevert("history consistent");
        idx.observeReorg();
        assertEq(idx.fold(0), 0);
        advance(1);
        assertEq(idx.lastHeight(), 1004);
    }

    function test_unobservedRecoveryThenSameForkCannotReuseTimer() public {
        advance(4);
        uint64 deadline = fork();
        r.put(idx.lastHeight(), idx.lastHash());
        r.tip(deadline, keccak256("restore"), true);
        r.put(idx.lastHeight(), keccak256("replacement"));
        r.tip(deadline + 1, keccak256("again"), true);
        assertFalse(idx.frozenExitReady());
        assertEq(idx.observeReorg(), deadline + 1 + idx.FROZEN_EXIT_DELAY());
    }

    function test_evenShallowForkOnReplacementBranchRequiresNewObservation() public {
        advance(4);
        uint64 deadline = fork();
        r.tip(deadline, keccak256("shallow replacement"), true);
        assertFalse(idx.frozenExitReady());
        assertEq(idx.observeReorg(), deadline + 144);
    }

    function test_shorterHeavierForkWaitsBeyondFoldedHeight() public {
        advance(10);
        uint64 folded = idx.lastHeight();
        r.tip(folded - 1, keccak256("shorter heavier"), true);
        assertEq(idx.observeReorg(), folded + 144);
        r.put(folded, keccak256("replacement at folded height"));
        extend(folded + 143);
        assertFalse(idx.frozenExitReady());
        extend(folded + 144);
        assertTrue(idx.frozenExitReady());
    }

    function test_noticeAlsoBindsObservedTipAndFoldedState() public {
        advance(4);
        uint64 deadline = fork();
        (uint64 from,,,,,) = idx.reorgNotice();
        r.put(from, keccak256("tampered test feeder"));
        extend(deadline);
        assertFalse(idx.frozenExitReady());
    }

    function test_staleConflictingBranchMayExitAfterMeasuredProgress() public {
        advance(4);
        uint64 deadline = fork();
        r.setStale(true);
        extend(deadline);
        assertFalse(idx.relayFresh());
        idx.freeze();
        assertTrue(idx.frozen());
    }

    function test_freezeSealsIndexEvenIfOriginalBranchLaterReturns() public {
        advance(4);
        int256 beforeS = idx.S();
        uint64 beforeH = idx.lastHeight();
        bytes32 beforeHash = idx.lastHash();
        seal();
        r.put(beforeH, beforeHash);
        r.tip(r.bestHeight() + 1, keccak256("recovery too late"), true);
        assertTrue(idx.historyConsistent());
        vm.expectRevert("index frozen");
        idx.fold();
        vm.expectRevert("index frozen");
        idx.fold(0);
        vm.expectRevert("index frozen");
        idx.fold(1, new address[](0));
        vm.expectRevert("index frozen");
        idx.observeReorg();
        vm.expectRevert("index frozen");
        idx.freeze();
        assertEq(idx.S(), beforeS);
        assertEq(idx.lastHeight(), beforeH);
        assertEq(idx.lastHash(), beforeHash);
        vm.expectRevert("index frozen");
        makeVault();
    }

    function test_mismatchBlocksMintAndNormalSettlementButPairsExit() public {
        vm.prank(alice);
        vault.mint(2e18);
        advance(20);
        fork();
        vm.expectRevert("deep Bitcoin reorg");
        vault.mint(1e18);
        vm.expectRevert("deep Bitcoin reorg");
        vault.settle();
        uint256 before = asset.balanceOf(alice);
        vm.prank(alice);
        vault.redeemPair(0, 1e18);
        assertEq(asset.balanceOf(alice) - before, N - N * 5 / 10000);
    }

    function test_halfExitPaysBothUnmatchedHoldersAndNeverOpensAnotherSeries() public {
        vm.prank(alice);
        vault.mint(2e18);
        (, SeriesToken n) = tokens(vault, 0);
        vm.prank(alice);
        n.transfer(bob, 2e18);
        advance(4);
        seal();
        vm.expectRevert("index frozen");
        vault.mint(1e18);
        vm.expectRevert("index frozen");
        vault.settle();
        vm.prank(address(0xCA11));
        vault.settleFrozen();
        assertTrue(vault.closed());
        assertEq(vault.currentId(), 0);
        assertEq(vault.yangShare(), 5e17);
        uint256 a = asset.balanceOf(alice);
        uint256 b = asset.balanceOf(bob);
        vm.prank(alice);
        vault.redeemSettled(0, 2e18, 0);
        vm.prank(bob);
        vault.redeemSettled(0, 0, 2e18);
        assertEq(asset.balanceOf(alice) - a, N - N * 5 / 10000);
        assertEq(asset.balanceOf(bob) - b, N - N * 5 / 10000);
        assertEq(vault.liabilities(), 0);
        assertEq(asset.balanceOf(address(vault)), 0);
        vm.expectRevert("vault closed");
        vault.settleFrozen();
        vm.expectRevert("vault closed");
        vault.settle();
        vm.expectRevert("vault closed");
        vault.mint(1);
    }

    function test_recordedOwnBoundaryWinsOverLaterCheckpoint() public {
        vm.prank(alice);
        vault.mint(1e18);
        advance(45);
        int256 own = idx.checkpointS(1019);
        assertTrue(own != idx.checkpointS(1039));
        uint256 expected = share(0, own);
        seal();
        vault.settleFrozen();
        assertEq(vault.yangShare(), expected);
        assertEq(vault.currentId(), 0);
    }

    function test_lateCreatedVaultIgnoresEarlierCheckpoint() public {
        advance(25);
        WujiVault late = makeVault();
        assertEq(late.currentSettlementHeight(), 1039);
        assertTrue(idx.checkpointed(1019));
        seal();
        late.settleFrozen();
        assertEq(late.yangShare(), 5e17);
    }

    function test_priorSettledPaymentsAndSharesDoNotChange() public {
        vm.prank(alice);
        vault.mint(3e18);
        advance(20);
        vault.settle();
        (,,,,,, uint256 oldShare) = vault.series(0);
        vm.prank(alice);
        vault.redeemSettled(0, 1e18, 0);
        vm.prank(alice);
        vault.mint(1e18);
        advance(4);
        seal();
        vault.settleFrozen();
        (,,,,,, uint256 afterShare) = vault.series(0);
        assertEq(oldShare, afterShare);
        assertEq(vault.currentId(), 1);
        assertEq(vault.yangShare(), 5e17);
        vm.prank(alice);
        vault.redeemSettled(0, 2e18, 3e18);
        vm.prank(alice);
        vault.redeemPair(1, 1e18);
        assertGe(asset.balanceOf(address(vault)), vault.liabilities());
        assertEq(vault.liabilities(), 0);
    }

    function test_exitExecutionGas() public {
        vm.prank(alice);
        vault.mint(1e18);
        advance(4);
        r.put(idx.lastHeight(), keccak256("replacement"));
        r.tip(r.bestHeight() + 1, keccak256("fork tip"), true);
        uint256 g = gasleft();
        uint64 deadline = idx.observeReorg();
        emit log_named_uint("observeReorg execution gas (test-warm)", g - gasleft());
        extend(deadline);
        g = gasleft();
        idx.freeze();
        emit log_named_uint("freeze execution gas (test-warm)", g - gasleft());
        g = gasleft();
        vault.settleFrozen();
        emit log_named_uint("settleFrozen half execution gas (test-warm)", g - gasleft());
    }

    function testFuzz_closedSolvencyRoundingAndConservation(uint256 amount, uint256 pairedBurn, bool recorded) public {
        amount = bound(amount, 1, 1000e18);
        pairedBurn = bound(pairedBurn, 0, amount);
        uint256 totalBefore = asset.balanceOf(alice) + asset.balanceOf(bob);
        vm.prank(alice);
        vault.mint(amount);
        if (pairedBurn > 0) {
            vm.prank(alice);
            vault.redeemPair(0, pairedBurn);
        }
        uint256 left = amount - pairedBurn;
        if (left > 0) {
            (, SeriesToken n) = tokens(vault, 0);
            vm.prank(alice);
            n.transfer(bob, left);
        }
        advance(recorded ? 20 : 4);
        seal();
        vault.settleFrozen();
        assertGe(asset.balanceOf(address(vault)), vault.liabilities());
        if (left > 0) {
            vm.prank(alice);
            vault.redeemSettled(0, left, 0);
            assertGe(asset.balanceOf(address(vault)), vault.liabilities());
            vm.prank(bob);
            vault.redeemSettled(0, 0, left);
        }
        assertEq(vault.liabilities(), 0);
        assertEq(
            asset.balanceOf(alice) + asset.balanceOf(bob) + asset.balanceOf(address(vault)) + asset.balanceOf(treasury),
            totalBefore
        );
    }
}
