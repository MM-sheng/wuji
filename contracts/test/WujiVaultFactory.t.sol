// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WujiTestBase} from "./Base.t.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {WujiVault} from "../src/WujiVault.sol";
import {WujiVaultFactory} from "../src/WujiVaultFactory.sol";
import {SeriesToken, SeriesTokenDeployer} from "../src/SeriesToken.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";
import {MockWBNB} from "./mocks/MockWBNB.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract NoSymbol { function totalSupply() external pure returns (uint256) { return 0; } } // not even an ERC-20 symbol()

contract WujiVaultFactoryTest is WujiTestBase {
    WujiIndex index; WujiVaultFactory factory; MockUSDT usdt; MockWBNB wbnb;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");

    function setUp() public {
        installHistory();
        vm.roll(1000); vm.warp(1_800_000_000);
        index = new WujiIndex(relay(), 1000, 8000);
        factory = new WujiVaultFactory(index, treasury, new SeriesTokenDeployer());
        usdt = new MockUSDT(); wbnb = new MockWBNB();
        usdt.mint(alice, 1e24); wbnb.mint(alice, 1e24);
    }

    function test_createsIndependentVaultsOnOneIndex() public {
        WujiVault vu = factory.create(usdt, 100e18);
        WujiVault vb = factory.create(wbnb, 1e18);
        assertEq(factory.count(), 2);
        assertEq(address(factory.vaults(0)), address(vu));
        assertEq(address(factory.vaultFor(address(wbnb), 1e18)), address(vb));
        assertEq(address(vu.index()), address(index));
        assertEq(address(vb.index()), address(index));
        assertEq(vu.NOTIONAL(), 100e18);
        assertEq(vb.NOTIONAL(), 1e18);
        assertEq(vu.treasury(), treasury);
        // token names carry the collateral
        (SeriesToken y,,,,,,) = vu.series(0);
        assertEq(y.symbol(), "YANG-USDT-0");
        assertEq(y.name(), "WUJI Yang USDT #0");
        (, SeriesToken n,,,,,) = vb.series(0);
        assertEq(n.symbol(), "YIN-WBNB-0");
    }

    function test_sameIndexSamePathDifferentNotional() public {
        WujiVault vu = factory.create(usdt, 100e18);
        WujiVault vb = factory.create(wbnb, 1e18);
        writeHashes(index, 1000, 1299, 42);
        index.fold(300);
        assertEq(vu.yangShare(), vb.yangShare());              // identical share...
        (uint256 yu,) = vu.values(); (uint256 yb,) = vb.values();
        assertEq(yu, 100e18 * vu.yangShare() / 1e18);         // ...different money
        assertEq(yb, 1e18 * vb.yangShare() / 1e18);
    }

    function test_duplicateMarketReverts() public {
        factory.create(usdt, 100e18);
        vm.expectRevert("exists");
        factory.create(usdt, 100e18);
        factory.create(usdt, 1000e18); // different notional is a different market
        assertEq(factory.count(), 2);
    }

    function test_anyoneCanCreate() public {
        vm.prank(alice);
        factory.create(wbnb, 1e18);
        assertEq(factory.count(), 1);
    }

    function test_symbolFallbackForOddTokens() public {
        NoSymbol odd = new NoSymbol();
        WujiVault v = factory.create(IERC20(address(odd)), 1e18);
        assertEq(v.collateralSymbol(), "TOKEN");
    }

    function test_createRefusesLargeIndexBacklog() public {
        writeHashes(index, 1000, 1999, 77);          // 1000 unfolded blocks
        vm.expectRevert("index backlog: fold first");
        factory.create(usdt, 100e18);
        index.fold(1024);                             // anyone advances the index...
        factory.create(usdt, 100e18);                 // ...then creation is cheap and exact
        assertEq(factory.count(), 1);
    }

    function test_createFoldsSmallBacklogItself() public {
        writeHashes(index, 1000, 1199, 78);          // 200 unfolded blocks: within the constructor's budget
        WujiVault v = factory.create(usdt, 100e18);
        assertEq(index.pending(), 0);
        (,, int256 s0,,,,) = v.series(0);
        assertEq(s0, index.S());
    }

    function test_mintInWbnbVault() public {
        WujiVault vb = factory.create(wbnb, 1e18);
        vm.startPrank(alice);
        wbnb.approve(address(vb), type(uint256).max);
        vb.mint(2e18);
        vm.stopPrank();
        assertEq(wbnb.balanceOf(address(vb)), 2e18);
        assertEq(wbnb.balanceOf(treasury), 2e18 * 5 / 10_000);
    }
}
