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

/// @dev Economic state machine only. Feeder does not assert real mining cost or Bitcoin validity.
contract FrozenExitHandler is Test {
    WujiVault public vault;
    WujiIndex public index;
    FrozenExitRelayMock public relay;
    MockUSDT public asset;
    address[4] public actors;
    uint256 public ghostFees;
    int256 public sealedS;
    uint64 public sealedHeight;
    bytes32 public sealedHash;
    uint256 public closedId;

    constructor(WujiVault v, WujiIndex i, FrozenExitRelayMock r, MockUSDT a) {
        vault = v;
        index = i;
        relay = r;
        asset = a;
        for (uint256 k; k < 4; ++k) {
            address who = address(uint160(0xA11CE + k));
            actors[k] = who;
            a.mint(who, 1e26);
            vm.prank(who);
            a.approve(address(v), type(uint256).max);
        }
    }

    function mint(uint256 seed, uint256 amount) external {
        if (
            vault.closed() || index.frozen() || !index.historyConsistent()
                || index.lastHeight() >= vault.currentSettlementHeight()
        ) return;
        amount = bound(amount, 1, 50e18);
        uint256 before = asset.balanceOf(vault.treasury());
        vm.prank(actors[seed % 4]);
        vault.mint(amount);
        ghostFees += asset.balanceOf(vault.treasury()) - before;
    }

    function progress(uint64 n, uint256 salt) external {
        if (index.frozen() || !index.historyConsistent()) {
            n = uint64(bound(n, 1, 200));
            relay.tip(relay.bestHeight() + n, keccak256(abi.encode(salt, "extend")), false);
        } else {
            n = uint64(bound(n, 1, 24));
            uint64 end = index.lastHeight() + n;
            for (uint64 h = index.lastHeight() + 1; h <= end; ++h) {
                relay.put(h, keccak256(abi.encode(h, salt)));
            }
            uint64 best = relay.bestHeight() > end + 6 ? relay.bestHeight() : end + 6;
            relay.tip(best, keccak256(abi.encode(best, salt)), false);
            index.fold(n);
        }
    }

    function switchBranch(uint256 salt) external {
        if (index.lastHash() == bytes32(0)) return;
        relay.put(index.lastHeight(), salt % 3 == 0 ? index.lastHash() : keccak256(abi.encode(salt, "fork")));
        relay.tip(relay.bestHeight() + 1, keccak256(abi.encode(salt, "new tip")), true);
    }

    function observe() external {
        if (!index.frozen() && !index.historyConsistent()) index.observeReorg();
    }

    function finishExit() external {
        if (index.frozenExitReady()) {
            index.freeze();
            sealedS = index.S();
            sealedHeight = index.lastHeight();
            sealedHash = index.lastHash();
        }
        if (index.frozen() && !vault.closed()) {
            vault.settleFrozen();
            closedId = vault.currentId();
        }
    }

    function settle() external {
        if (
            !index.frozen() && index.historyConsistent() && !vault.closed()
                && index.checkpointed(vault.currentSettlementHeight())
        ) vault.settle();
    }

    function transfer(uint256 seed, uint256 idSeed, bool yangSide, uint256 amount) external {
        (SeriesToken y, SeriesToken n,,,,,) = vault.series(idSeed % (vault.currentId() + 1));
        SeriesToken t = yangSide ? y : n;
        address from = actors[seed % 4];
        address to = actors[(seed % 4 + 1) % 4];
        uint256 balance = t.balanceOf(from);
        if (balance == 0) return;
        vm.prank(from);
        t.transfer(to, bound(amount, 1, balance));
    }

    function redeem(uint256 seed, uint256 idSeed, bool paired, uint256 a, uint256 b) external {
        uint256 id = idSeed % (vault.currentId() + 1);
        (SeriesToken y, SeriesToken n,,,, bool settled,) = vault.series(id);
        address who = actors[seed % 4];
        uint256 ys = y.balanceOf(who);
        uint256 ns = n.balanceOf(who);
        uint256 before = asset.balanceOf(vault.treasury());
        if (paired) {
            uint256 cap = ys < ns ? ys : ns;
            if (cap == 0) return;
            vm.prank(who);
            vault.redeemPair(id, bound(a, 1, cap));
        } else {
            if (!settled) return;
            a = bound(a, 0, ys);
            b = bound(b, 0, ns);
            if (a == 0 && b == 0) return;
            vm.prank(who);
            vault.redeemSettled(id, a, b);
        }
        ghostFees += asset.balanceOf(vault.treasury()) - before;
    }
}

contract FrozenExitInvariants is Test {
    WujiIndex idx;
    WujiVault vault;
    MockUSDT asset;
    FrozenExitHandler handler;
    address constant TREASURY = address(0xFEE);

    function setUp() public {
        vm.warp(1_800_000_000);
        FrozenExitRelayMock r = new FrozenExitRelayMock();
        idx = new WujiIndex(BitcoinRelay(address(r)), 1000, 20, RelayerRewards(address(0)));
        asset = new MockUSDT();
        vault = new WujiVault(asset, idx, 100e18, TREASURY, new SeriesTokenDeployer());
        handler = new FrozenExitHandler(vault, idx, r, asset);
        targetContract(address(handler));
    }

    function invariant_solventAndConserved() public view {
        uint256 backing = asset.balanceOf(address(vault));
        uint256 fees = asset.balanceOf(TREASURY);
        uint256 total = backing + fees;
        assertGe(backing, vault.liabilities());
        assertEq(fees, handler.ghostFees());
        for (uint256 k; k < 4; ++k) {
            total += asset.balanceOf(handler.actors(k));
        }
        assertEq(total, 4e26);
    }

    function invariant_openOrTerminalAndAlwaysPaired() public view {
        uint256 open;
        for (uint256 id; id <= vault.currentId(); ++id) {
            (SeriesToken y, SeriesToken n,,,, bool settled, uint256 sh) = vault.series(id);
            if (!settled) {
                ++open;
                assertEq(id, vault.currentId());
                assertEq(y.totalSupply(), n.totalSupply());
            } else {
                assertLe(sh, 1e18);
            }
        }
        assertEq(open, vault.closed() ? 0 : 1);
        (uint256 yv, uint256 nv) = vault.values();
        assertEq(yv + nv, 100e18);
    }

    function invariant_terminalStateCannotAdvance() public view {
        if (idx.frozen()) {
            assertEq(idx.S(), handler.sealedS());
            assertEq(idx.lastHeight(), handler.sealedHeight());
            assertEq(idx.lastHash(), handler.sealedHash());
            assertFalse(idx.frozenExitReady());
        }
        if (vault.closed()) {
            assertTrue(idx.frozen());
            assertEq(vault.currentId(), handler.closedId());
        }
    }

    function test_handlerTraversesTerminalStateWithUnmatchedExits() public {
        handler.mint(0, 2e18);
        handler.transfer(0, 0, false, 2e18);
        handler.progress(4, 1);
        handler.switchBranch(1);
        handler.observe();
        handler.progress(200, 1);
        handler.finishExit();
        assertTrue(idx.frozen());
        assertTrue(vault.closed());
        handler.redeem(0, 0, false, 2e18, 0);
        handler.redeem(1, 0, false, 0, 2e18);
        handler.switchBranch(3);
        handler.progress(20, 1);
        handler.finishExit();
        handler.mint(0, 1e18);
        assertEq(vault.liabilities(), 0);
        invariant_solventAndConserved();
        invariant_openOrTerminalAndAlwaysPaired();
        invariant_terminalStateCannotAdvance();
    }
}
