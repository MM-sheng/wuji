// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WujiTestBase} from "./Base.t.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {WujiVault} from "../src/WujiVault.sol";
import {SeriesToken} from "../src/SeriesToken.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract FeeOnTransferToken is ERC20("Fee token", "FEE") {
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

contract WujiVaultTest is WujiTestBase {
    uint256 constant WAD = 1e18;
    uint256 constant NOTIONAL = 100e18;
    uint64 constant GENESIS = 1000;
    uint64 constant INTERVAL = 2000;

    MockUSDT usdt;
    WujiIndex index;
    WujiVault vault;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        installHistory();
        vm.roll(GENESIS);
        vm.warp(1_800_000_000);
        usdt = new MockUSDT();
        index = new WujiIndex(GENESIS, INTERVAL);
        vault = new WujiVault(usdt, index, NOTIONAL, treasury);
        for (uint256 i = 0; i < 2; i++) {
            address a = i == 0 ? alice : bob;
            usdt.mint(a, 1_000_000e18);
            vm.prank(a);
            usdt.approve(address(vault), type(uint256).max);
        }
    }

    // move the index: write `n` fake block hashes and tick. Returns the ΔS (wad) they produced.
    function advance(uint64 n, uint256 salt) internal returns (int256 dS) {
        uint64 from = uint64(block.number);
        if (n == 0) return 0;
        dS = writeHashes(index, from, from + n - 1, salt);
        index.tick(n);
    }

    function reachSettlement(uint256 salt) internal returns (int256 dS) {
        uint64 boundary = vault.currentSettlementBlock();
        uint64 from = uint64(block.number);
        if (from <= boundary) dS = writeHashes(index, from, boundary, salt);
        while (!index.checkpointed(boundary)) index.tick();
    }

    function series(uint256 id)
        internal
        view
        returns (SeriesToken yang, SeriesToken yin, int256 s0, uint64 settlementBlock, bool settled, uint256 share)
    {
        (yang, yin, s0,, settlementBlock, settled, share) = vault.series(id);
    }

    // ---------------------------------------------------------------- basics

    function test_opensSeriesZeroAtDeploy() public view {
        assertEq(vault.currentId(), 0);
        (,, int256 s0, uint64 settlementBlock, bool settled,) = series(0);
        assertEq(s0, index.S());
        assertEq(settlementBlock, GENESIS + INTERVAL - 1);
        assertFalse(settled);
        assertEq(vault.yangShare(), WAD / 2);
    }

    function test_mintPullsNotionalPlusFee() public {
        vm.prank(alice);
        vault.mint(3e18);
        (SeriesToken yang, SeriesToken yin,,,,) = series(0);
        assertEq(yang.balanceOf(alice), 3e18);
        assertEq(yin.balanceOf(alice), 3e18);
        assertEq(usdt.balanceOf(address(vault)), 300e18);
        assertEq(usdt.balanceOf(treasury), 300e18 * 5 / 10_000); // 0.15
        assertEq(usdt.balanceOf(alice), 1_000_000e18 - 300e18 - 0.15e18);
    }

    function test_mintRejectsFeeOnTransferCollateral() public {
        FeeOnTransferToken feeToken = new FeeOnTransferToken();
        WujiVault feeVault = new WujiVault(feeToken, index, NOTIONAL, treasury);
        feeToken.mint(alice, 1_000e18);
        vm.startPrank(alice);
        feeToken.approve(address(feeVault), type(uint256).max);
        vm.expectRevert("unsupported collateral");
        feeVault.mint(1e18);
        vm.stopPrank();
        assertEq(feeToken.balanceOf(address(feeVault)), 0);
    }

    function test_redeemPairReturnsNotionalMinusFee() public {
        vm.startPrank(alice);
        vault.mint(2e18);
        advance(50, 1); // price moved; pairs still redeem at par
        vault.redeemPair(0, 2e18);
        vm.stopPrank();
        assertEq(usdt.balanceOf(address(vault)), 0);
        assertEq(usdt.balanceOf(alice), 1_000_000e18 - 0.1e18 - 0.1e18); // mint fee + redeem fee
        assertEq(usdt.balanceOf(treasury), 0.2e18);
    }

    function test_fractionalPairsRoundAgainstUser() public {
        vm.prank(alice);
        vault.mint(1); // 1e-18 of a pair = 100 wei of collateral
        assertEq(usdt.balanceOf(address(vault)), 100);
        assertEq(usdt.balanceOf(treasury), 1); // fee ceil(100 · 5 / 10000) = 1 wei
        vm.prank(alice);
        vault.redeemPair(0, 1);
        assertEq(usdt.balanceOf(address(vault)), 0);
        assertEq(usdt.balanceOf(treasury), 1); // redeem fee floors to 0
        // sub-wei collateral: 3 · 100e18 / 1e18 wouldn't divide evenly only below 1e16 pairs; check ceil
        vm.prank(alice);
        vault.mint(1e16 + 1); // 1.00…01 collateral → ceil to 1e18/100 + 1 wei... i.e. 1e18 + 100 wei
        assertEq(usdt.balanceOf(address(vault)), 1e18 + 100);
    }

    // ---------------------------------------------------------------- share math

    function test_shareTracksIndex() public {
        int256 dS = advance(200, 2);
        int256 expected = int256(WAD / 2) + dS / 2;
        assertEq(int256(vault.yangShare()), expected);
        (uint256 y, uint256 n) = vault.values();
        assertEq(y + n, NOTIONAL);
        assertEq(y, NOTIONAL * uint256(expected) / WAD);
    }

    function testFuzz_valuesAlwaysSumToNotional(uint64 blocks, uint256 salt) public {
        blocks = uint64(bound(blocks, 0, 255));
        advance(blocks, salt);
        (uint256 y, uint256 n) = vault.values();
        assertEq(y + n, NOTIONAL);
        assertLe(vault.yangShare(), WAD);
    }

    function test_shareClampsAtBounds() public {
        // hand-craft: 255 blocks of all-0xff hashes → byteSum 8160 → +4080·UNIT each → ΔS = 255·4080·3.3e11 wad ≈ 3.4e17
        // that is not enough to clamp (needs ΔS ≥ 1e18), so use a series whose s0 is far away instead:
        // deploy a vault on an index whose S we then push through several ticks.
        int256 total;
        for (uint256 k = 0; k < 6; k++) {
            total += advanceAll(255, true); // ≈ +2.06e18 → clamp high
        }
        assertGt(total, int256(WAD));
        assertEq(vault.yangShare(), WAD);
        (uint256 y, uint256 n) = vault.values();
        assertEq(y, NOTIONAL);
        assertEq(n, 0);
    }

    function advanceAll(uint64 n, bool up) internal returns (int256 dS) {
        uint64 from = uint64(block.number);
        // bytes32(0) would read as "unset" in the mock history, so the down case uses 0x01..01 (byteSum 32)
        bytes32 h = up
            ? bytes32(type(uint256).max)
            : bytes32(uint256(0x0101010101010101010101010101010101010101010101010101010101010101));
        dS = writeConstant(index, from, from + n - 1, h);
        index.tick(n);
    }

    // ---------------------------------------------------------------- settlement

    function test_settleRevertsBeforeSettlementBlock() public {
        vm.expectRevert("settlement block not mined");
        vault.settle();
    }

    function test_mintRevertsAtSettlementBlockUntilSettled() public {
        reachSettlement(20);
        vm.prank(alice);
        vm.expectRevert("series ended: settle first");
        vault.mint(1e18);
        vault.settle();
        vm.prank(alice);
        vault.mint(1e18); // series 1 is open
        assertEq(vault.currentId(), 1);
    }

    function test_settleFreezesShareAndOpensNext() public {
        vm.prank(alice);
        vault.mint(10e18);
        int256 dS = advance(120, 3);
        dS += reachSettlement(31);
        (uint256 settledId, uint256 nextId) = vault.settle();
        assertEq(settledId, 0);
        assertEq(nextId, 1);
        (,,,, bool settled, uint256 share) = series(0);
        assertTrue(settled);
        assertEq(int256(share), int256(WAD / 2) + dS / 2);
        (,, int256 s0Next,, bool settledNext,) = series(1);
        assertEq(s0Next, index.S());
        assertFalse(settledNext);
        assertEq(vault.yangShare(), WAD / 2); // fresh series starts at ½
        // settled share no longer moves with the index
        advance(100, 4);
        (,,,,, uint256 shareAfter) = series(0);
        assertEq(shareAfter, share);
    }

    function test_lateSettlementCannotChooseLaterIndexValue() public {
        int256 boundaryS = reachSettlement(32);
        int256 later = advance(200, 33);
        assertTrue(later != 0);
        vault.settle();
        (,,,,, uint256 share) = series(0);
        assertEq(int256(share), int256(WAD / 2) + boundaryS / 2);
        assertEq(index.S(), boundaryS + later);
        (,, int256 nextS0,,,) = series(1);
        assertEq(nextS0, boundaryS);
    }

    function test_settleRequiresIndexCatchupToCheckpoint() public {
        uint64 boundary = vault.currentSettlementBlock();
        int256 expected = writeHashes(index, uint64(block.number), boundary, 77);
        assertEq(index.pending(), INTERVAL);

        vm.expectRevert("index backlog: tick first");
        vault.settle();
        assertEq(vault.currentId(), 0);
        assertEq(index.lastBlock(), GENESIS - 1);

        assertEq(index.tick(), 1024);
        assertEq(boundary - index.lastBlock(), INTERVAL - 1024);
        vault.settle();
        assertEq(index.S(), expected);
        (,, int256 nextS0,,,) = series(1);
        assertEq(nextS0, expected);
    }

    function test_redeemSettledPaysFrozenValues() public {
        vm.prank(alice);
        vault.mint(10e18);
        (SeriesToken yang, SeriesToken yin,,,,) = series(0);
        vm.prank(alice);
        yin.transfer(bob, 10e18); // alice keeps YANG, bob holds YIN
        advance(200, 5);
        reachSettlement(51);
        vault.settle();
        (,,,,, uint256 share) = series(0);

        uint256 aliceBefore = usdt.balanceOf(alice);
        uint256 bobBefore = usdt.balanceOf(bob);
        vm.prank(alice);
        vault.redeemSettled(0, 10e18, 0);
        vm.prank(bob);
        vault.redeemSettled(0, 0, 10e18);

        uint256 yangVal = 10e18 * NOTIONAL * share / (WAD * WAD);
        uint256 yinVal = 10e18 * NOTIONAL * (WAD - share) / (WAD * WAD);
        assertEq(usdt.balanceOf(alice) - aliceBefore, yangVal - yangVal * 5 / 10_000);
        assertEq(usdt.balanceOf(bob) - bobBefore, yinVal - yinVal * 5 / 10_000);
        assertEq(yangVal + yinVal, 1000e18);
        assertEq(yang.totalSupply(), 0);
        assertEq(yin.totalSupply(), 0);
        assertLe(usdt.balanceOf(address(vault)), 1); // only rounding dust can remain
    }

    function test_redeemSettledRevertsOnOpenSeries() public {
        vm.prank(alice);
        vault.mint(1e18);
        vm.prank(alice);
        vm.expectRevert("not settled");
        vault.redeemSettled(0, 1e18, 0);
    }

    function test_onlyVaultMintsSeriesTokens() public {
        (SeriesToken yang,,,,,) = series(0);
        vm.expectRevert("vault only");
        yang.mint(alice, 1);
    }

    function test_liabilitiesNeverExceedBalance() public {
        vm.prank(alice);
        vault.mint(7e18);
        vm.prank(bob);
        vault.mint(3e18);
        advance(90, 6);
        assertLe(vault.liabilities(), usdt.balanceOf(address(vault)));
        reachSettlement(61);
        vault.settle();
        vm.prank(alice);
        vault.mint(2e18);
        assertLe(vault.liabilities(), usdt.balanceOf(address(vault)));
        vm.prank(bob);
        vault.redeemSettled(0, 3e18, 3e18);
        assertLe(vault.liabilities(), usdt.balanceOf(address(vault)));
    }
}
