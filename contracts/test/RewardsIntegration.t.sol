// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {BitcoinRelayTest, EasyRelay} from "./BitcoinRelay.t.sol";
import {BitcoinRelay} from "../src/BitcoinRelay.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {WujiVault} from "../src/WujiVault.sol";
import {SeriesTokenDeployer} from "../src/SeriesToken.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";
contract RewardsIntegrationTest is BitcoinRelayTest {
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    address constant FOLDER = address(0xF01D);
    function wired() internal returns(RelayerRewards rewards, EasyRelay r, WujiIndex idx) {
        uint64 nonce = vm.getNonce(address(this));
        rewards = new RelayerRewards(vm.computeCreateAddress(address(this),nonce+1),vm.computeCreateAddress(address(this),nonce+2));
        r = new EasyRelay(cp, rewards);
        idx = new WujiIndex(r, 1001, 4320, rewards);
        assertEq(rewards.relay(), address(r)); assertEq(rewards.index(), address(idx));
    }
    function test_rewardsFollowFinalizedForkAndOriginalSubmitter() public {
        (RelayerRewards rewards, EasyRelay r, WujiIndex idx) = wired();
        bytes32 root = r.bestHash();
        vm.startPrank(ALICE); extend(r, root, 3, 100); vm.stopPrank();
        assertEq(rewards.totalPoints(), 0); // Tentative main-chain headers are not paid.
        vm.startPrank(BOB); extend(r, root, 10, 200); vm.stopPrank();
        vm.prank(FOLDER); idx.fold();
        assertEq(rewards.points(ALICE), 0); assertEq(rewards.points(BOB), 4); assertEq(rewards.points(FOLDER), 4);
        vm.prank(FOLDER); idx.fold(); assertEq(rewards.totalPoints(), 8);
        // A known canonical header cannot steal its original submission attribution.
        bytes memory duplicate = next(r, root, 200);
        vm.prank(ALICE); r.submit(duplicate); assertEq(rewards.totalPoints(), 8);
        assertEq(r.submitter(r.headerAt(1001)), BOB);
        vm.expectRevert("index only"); r.rewardFinalized(1001);
        // Deep reorgs cannot result in a second payment for the same index history.
        vm.startPrank(ALICE); extend(r, root, 12, 300); vm.stopPrank();
        vm.expectRevert("deep Bitcoin reorg"); idx.fold(); assertEq(rewards.totalPoints(), 8);
    }
    function test_realHeadersRewardGasAndVaultFeeRoute() public {
        uint64 nonce = vm.getNonce(address(this));
        RelayerRewards rewards = new RelayerRewards(vm.computeCreateAddress(address(this),nonce+1),vm.computeCreateAddress(address(this),nonce+2));
        BitcoinRelay r = new BitcoinRelay(cp,798335,uint32(vm.parseJsonUint(meta,".epochStartTime")),1e30,rewards);
        WujiIndex idx = new WujiIndex(r,798336,12,rewards);
        FeeRouter router = new FeeRouter(rewards);
        MockUSDT token = new MockUSDT();
        WujiVault vault = new WujiVault(token,idx,100e18,address(router),new SeriesTokenDeployer());
        bytes memory batch = slice(headers,0,24*80);
        uint256 g = gasleft(); vm.prank(ALICE); r.submit(batch); emit log_named_uint("reward relay gas/header",(g-gasleft())/24);
        g = gasleft(); vm.prank(FOLDER); idx.fold(16); emit log_named_uint("reward fold gas/height",(g-gasleft())/16);
        assertEq(rewards.points(ALICE),16); assertEq(rewards.points(FOLDER),16);
        idx.fold(16); vault.settle();
        token.mint(address(this),1000e18); token.approve(address(vault),type(uint256).max);
        vault.mint(1e18);
        uint256 fee = token.balanceOf(address(router)); assertGt(fee,0);
        router.route(address(token));
        assertEq(token.balanceOf(address(rewards)),fee/2); assertEq(token.balanceOf(router.DEAD()),fee/2);
    }
    function test_rewardBatchGasBudget() public {
        uint64 nonce = vm.getNonce(address(this));
        RelayerRewards rewards = new RelayerRewards(vm.computeCreateAddress(address(this),nonce+1),vm.computeCreateAddress(address(this),nonce+2));
        BitcoinRelay r = new BitcoinRelay(cp,798335,uint32(vm.parseJsonUint(meta,".epochStartTime")),1e30,rewards);
        new WujiIndex(r,798336,4320,rewards);
        vm.prank(ALICE); r.submit(slice(headers,0,80)); // Includes first worker/epoch setup.
        bytes memory batch = slice(headers,80,24*80);
        uint256 g = gasleft(); vm.prank(ALICE); r.submit(batch);
        uint256 perHeader = (g-gasleft())/24;
        emit log_named_uint("steady reward gas/header",perHeader); assertLe(perHeader,70_000);
        batch = slice(headers,25*80,24*80);
        g = gasleft(); vm.prank(BOB); r.submit(batch);
        perHeader = (g-gasleft())/24;
        emit log_named_uint("new worker reward gas/header",perHeader); assertLe(perHeader,70_000);
        assertEq(r.submitter(r.headerAt(798336)),ALICE);
        assertEq(r.submitter(r.headerAt(798361)),BOB);
    }
    function test_alternatingWorkersKeepAttributionAndDuplicatesDoNotSteal() public {
        (RelayerRewards rewards, EasyRelay r, WujiIndex idx) = wired();
        bytes memory first;
        for(uint256 i;i<20;++i) {
            bytes memory h = next(r,r.bestHash(),10000+i);
            if(i==0)first=h;
            vm.prank(i%2==0?ALICE:BOB);r.submit(h);
        }
        vm.prank(BOB);r.submit(first);
        for(uint64 h=1001;h<=1020;++h)assertEq(r.submitter(r.headerAt(h)),h%2==1?ALICE:BOB);
        assertEq(r.submitter(bytes32(uint256(123))),address(0));
        assertEq(r.submitter(r.checkpointHash()),address(0));
        vm.prank(FOLDER);idx.fold();
        assertEq(rewards.points(ALICE),7);assertEq(rewards.points(BOB),7);assertEq(rewards.points(FOLDER),14);
    }
}
