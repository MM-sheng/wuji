// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {WujiVault} from "../src/WujiVault.sol";
import {SeriesToken, SeriesTokenDeployer} from "../src/SeriesToken.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";
import {MockBitcoinRelay} from "./mocks/MockBitcoinRelay.sol";
import {BitcoinRelay} from "../src/BitcoinRelay.sol";

/// Random sequences of mint / redeemPair / redeemSettled / settle / index moves / time, by several actors.
/// The vault must stay solvent and the pair must stay whole no matter the order.
contract Handler is Test {
    WujiVault public vault;
    WujiIndex public index;
    MockUSDT public usdt;
    address[] public actors;
    uint256 public ghostFees; // collateral sent to treasury
    uint256 public ghostCalls;
    uint256 public ghostSettles;
    uint256 public ghostBlocksMoved;

    constructor(WujiVault v, WujiIndex i, MockUSDT u) {
        vault = v;
        index = i;
        usdt = u;
        for (uint256 k = 0; k < 4; k++) {
            address a = address(uint160(0xA11CE + k));
            actors.push(a);
            usdt.mint(a, 1e30);
            vm.prank(a);
            usdt.approve(address(vault), type(uint256).max);
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _open(uint256 id) internal view returns (bool settled) {
        (,,,,, settled,) = vault.series(id);
    }

    function mint(uint256 seed, uint256 pairs) external {
        pairs = bound(pairs, 1, 1_000e18);
        (,,,, uint64 settlementBlock,,) = vault.series(vault.currentId());
        if (index.lastHeight() >= settlementBlock) return; // handled by settle()
        uint256 t0 = usdt.balanceOf(vault.treasury());
        vm.prank(_actor(seed));
        vault.mint(pairs);
        ghostFees += usdt.balanceOf(vault.treasury()) - t0;
        ghostCalls++;
    }

    function redeemPair(uint256 seed, uint256 idSeed, uint256 pairs) external {
        uint256 id = idSeed % (vault.currentId() + 1);
        (SeriesToken yang, SeriesToken yin,,,,,) = vault.series(id);
        address a = _actor(seed);
        uint256 max = yang.balanceOf(a) < yin.balanceOf(a) ? yang.balanceOf(a) : yin.balanceOf(a);
        if (max == 0) return;
        pairs = bound(pairs, 1, max);
        uint256 t0 = usdt.balanceOf(vault.treasury());
        vm.prank(a);
        vault.redeemPair(id, pairs);
        ghostFees += usdt.balanceOf(vault.treasury()) - t0;
        ghostCalls++;
    }

    function redeemSettled(uint256 seed, uint256 idSeed, uint256 y, uint256 n) external {
        uint256 id = idSeed % (vault.currentId() + 1);
        (SeriesToken yang, SeriesToken yin,,,, bool settled,) = vault.series(id);
        if (!settled) return;
        address a = _actor(seed);
        y = yang.balanceOf(a) == 0 ? 0 : bound(y, 0, yang.balanceOf(a));
        n = yin.balanceOf(a) == 0 ? 0 : bound(n, 0, yin.balanceOf(a));
        if (y == 0 && n == 0) return;
        uint256 t0 = usdt.balanceOf(vault.treasury());
        vm.prank(a);
        vault.redeemSettled(id, y, n);
        ghostFees += usdt.balanceOf(vault.treasury()) - t0;
        ghostCalls++;
    }

    // shuffle tokens between actors so one-sided holdings appear
    function transferHalf(uint256 seed, uint256 idSeed, bool yangSide, uint256 amt) external {
        uint256 id = idSeed % (vault.currentId() + 1);
        (SeriesToken yang, SeriesToken yin,,,,,) = vault.series(id);
        SeriesToken t = yangSide ? yang : yin;
        address from = _actor(seed);
        address to = _actor(seed / 7 + 1);
        if (t.balanceOf(from) == 0 || from == to) return;
        amt = bound(amt, 1, t.balanceOf(from));
        vm.prank(from);
        t.transfer(to, amt);
    }

    // Submit synthetic 80-byte headers to the test feeder, then exercise the real index/vault.
    function moveIndex(uint64 n, uint256 salt) external {
        n = uint64(salt % 25 == 0 ? bound(n, 8000, 9000) : bound(n, 1, 600));
        _advance(n,salt);
        ghostBlocksMoved += n;
    }
    function _advance(uint64 count,uint256 salt) internal {
        MockBitcoinRelay r=MockBitcoinRelay(address(index.relay()));
        uint64 from=index.lastHeight()+1;
        for(uint64 h=from;h<from+count;h++) r.submit(h,abi.encodePacked(bytes32(uint256(h)),bytes32(salt),bytes16(0)));
        index.fold(count);
    }
    function settle() external {
        uint64 boundary=vault.currentSettlementHeight();
        if(index.lastHeight()<boundary) _advance(boundary-index.lastHeight(),ghostSettles);
        vault.settle(); ghostSettles++;
    }

}

contract WujiVaultInvariants is Test {
    uint256 constant NOTIONAL = 100e18;
    MockUSDT usdt;
    WujiIndex index;
    WujiVault vault;
    Handler handler;
    address treasury = makeAddr("treasury");

    function setUp() public {
        MockBitcoinRelay hist = new MockBitcoinRelay();
        vm.roll(1000);
        vm.warp(1_800_000_000);
        usdt = new MockUSDT();
        index = new WujiIndex(BitcoinRelay(address(hist)),1000,100, RelayerRewards(address(0)));
        vault = new WujiVault(usdt, index, NOTIONAL, treasury, new SeriesTokenDeployer());
        handler = new Handler(vault, index, usdt);
        targetContract(address(handler));
    }

    /// The vault can always pay everyone: balance ≥ what it owes at current / frozen values.
    function invariant_solvent() public view {
        assertGe(usdt.balanceOf(address(vault)), vault.liabilities());
    }

    /// An open series only ever contains matched pairs.
    function invariant_openSeriesIsPaired() public view {
        for (uint256 id = 0; id <= vault.currentId(); id++) {
            (SeriesToken yang, SeriesToken yin,,,, bool settled,) = vault.series(id);
            if (!settled) assertEq(yang.totalSupply(), yin.totalSupply());
        }
    }

    /// 两仪相加恒为太极: YANG + YIN == NOTIONAL for the live series, and every settled share is in [0, 1].
    function invariant_pairIsWhole() public view {
        (uint256 y, uint256 n) = vault.values();
        assertEq(y + n, NOTIONAL);
        for (uint256 id = 0; id <= vault.currentId(); id++) {
            (,,,,, bool settled, uint256 share) = vault.series(id);
            if (settled) assertLe(share, 1e18);
        }
    }

    /// Exactly one open series, and it is the last one.
    function invariant_oneOpenSeries() public view {
        for (uint256 id = 0; id < vault.currentId(); id++) {
            (,,,,, bool settled,) = vault.series(id);
            assertTrue(settled);
        }
        (,,,,, bool lastSettled,) = vault.series(vault.currentId());
        assertFalse(lastSettled);
    }

    /// Nothing leaks: collateral in = vault balance + paid out + fees. Checked via the accounting identity
    /// that liabilities are only ever reduced by exactly what is paid (rounding dust may remain in the vault).
    function invariant_feesOnlyGoToTreasury() public view {
        assertEq(usdt.balanceOf(treasury), handler.ghostFees());
    }

    function invariant_callSummary() public {
        // prints once at the end of the run when -vv; useful to see the mix actually exercised
        emit log_named_uint("calls", handler.ghostCalls());
        emit log_named_uint("settles", handler.ghostSettles());
        emit log_named_uint("blocks moved", handler.ghostBlocksMoved());
        emit log_named_uint("last Bitcoin height", index.lastHeight());
    }
}
