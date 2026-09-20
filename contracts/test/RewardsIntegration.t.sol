// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {BitcoinRelayTest, EasyRelay} from "./BitcoinRelay.t.sol";
import {BitcoinRelayPackedBaseline} from "./reference/BitcoinRelayPackedBaseline.sol";
import {BitcoinRelay} from "../src/BitcoinRelay.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {WujiVault} from "../src/WujiVault.sol";
import {SeriesTokenDeployer} from "../src/SeriesToken.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";
contract RewardsIntegrationTest is BitcoinRelayTest {
    address constant ALICE=address(0xA11CE);address constant BOB=address(0xB0B);address constant FOLDER=address(0xF01D);
    function one(address token) internal pure returns(address[] memory list){list=new address[](1);list[0]=token;}
    function wired() internal returns(RelayerRewards rewards,EasyRelay r,WujiIndex idx) {
        uint64 nonce=vm.getNonce(address(this));rewards=new RelayerRewards(vm.computeCreateAddress(address(this),nonce+2),1001);
        r=new EasyRelay(cp,ancestors);idx=new WujiIndex(r,1001,4320,rewards);
        assertEq(rewards.index(),address(idx));assertEq(rewards.lastHeight(),idx.lastHeight());
    }
    function test_onlyFinalizedFolderGetsOneOffBounty() public {
        (RelayerRewards rewards,EasyRelay r,WujiIndex idx)=wired();MockUSDT token=new MockUSDT();
        token.mint(address(rewards),1_000_000);rewards.sync(address(token));
        bytes32 root=r.bestHash();vm.startPrank(ALICE);extend(r,root,3,100);vm.stopPrank();
        assertEq(rewards.claimable(address(token),ALICE),0);
        vm.startPrank(BOB);extend(r,root,10,200);vm.stopPrank();
        uint256 expected=rewards.quote(address(token),4);vm.prank(FOLDER);assertEq(idx.fold(16,one(address(token))),4);
        assertEq(rewards.claimable(address(token),FOLDER),expected);
        assertEq(rewards.claimable(address(token),ALICE),0);assertEq(rewards.claimable(address(token),BOB),0);
        vm.prank(FOLDER);assertEq(idx.fold(16,one(address(token))),0);
        vm.prank(FOLDER);assertEq(rewards.claim(address(token)),expected);
        bytes memory duplicate=next(r,root,200);vm.prank(ALICE);submitAtTime(r,duplicate);
        assertEq(r.submitter(r.headerAt(1001)),BOB);assertEq(rewards.claimable(address(token),FOLDER),0);
        vm.startPrank(ALICE);extend(r,root,12,300);vm.stopPrank();
        vm.expectRevert("deep Bitcoin reorg");idx.fold(16,one(address(token)));
        assertEq(rewards.lastHeight(),1004);assertEq(token.balanceOf(FOLDER),expected);
    }
    function test_noRewardFoldConsumesOldWorkBeforeNewFees() public {
        (RelayerRewards rewards,EasyRelay r,WujiIndex idx)=wired();MockUSDT token=new MockUSDT();
        extend(r,r.bestHash(),10,100);vm.prank(ALICE);idx.fold();
        assertEq(rewards.lastHeight(),1004);token.mint(address(rewards),1_000_000);rewards.sync(address(token));
        vm.prank(ALICE);assertEq(rewards.claim(address(token)),0);
        extend(r,r.bestHash(),1,200);vm.prank(BOB);idx.fold(16,one(address(token)));
        assertEq(rewards.claimable(address(token),BOB),100);assertEq(rewards.claimable(address(token),ALICE),0);
    }
    function test_rewardFailureRollsBackIndexAndCheckpoints() public {
        uint64 nonce=vm.getNonce(address(this));RelayerRewards rewards=new RelayerRewards(vm.computeCreateAddress(address(this),nonce+2),798336);
        BitcoinRelay r=new BitcoinRelay(cp,798335,uint32(vm.parseJsonUint(meta,".epochStartTime")),1e30,ancestors);
        WujiIndex idx=new WujiIndex(r,798336,12,rewards);submitAtTime(r,slice(headers,0,24*80));
        address[] memory bad=new address[](2);bad[0]=address(1);bad[1]=address(1);
        vm.expectRevert("tokens not sorted unique");idx.fold(16,bad);
        assertEq(idx.lastHeight(),798335);assertEq(idx.S(),0);assertEq(idx.lastHash(),bytes32(0));
        assertFalse(idx.checkpointed(798347));assertEq(idx.nextCheckpointHeight(),798347);assertEq(rewards.lastHeight(),798335);
    }
    function test_constructorRejectsWrongBindingAndGenesis() public {
        RelayerRewards wrong=new RelayerRewards(address(0x1234),798336);
        vm.expectRevert("reward index mismatch");new WujiIndex(relay,798336,4320,wrong);
        uint64 nonce=vm.getNonce(address(this));wrong=new RelayerRewards(vm.computeCreateAddress(address(this),nonce+1),798337);
        vm.expectRevert("reward index mismatch");new WujiIndex(relay,798336,4320,wrong);
    }
    function test_realHeadersRewardGasAndVaultFeeRoute() public {
        uint64 nonce=vm.getNonce(address(this));RelayerRewards rewards=new RelayerRewards(vm.computeCreateAddress(address(this),nonce+2),798336);
        BitcoinRelay r=new BitcoinRelay(cp,798335,uint32(vm.parseJsonUint(meta,".epochStartTime")),1e30,ancestors);
        WujiIndex idx=new WujiIndex(r,798336,12,rewards);FeeRouter router=new FeeRouter(rewards);MockUSDT token=new MockUSDT();
        WujiVault vault=new WujiVault(token,idx,100e18,address(router),new SeriesTokenDeployer());
        token.mint(address(this),1000e18);token.approve(address(vault),type(uint256).max);vault.mint(1e18);
        uint256 fee=token.balanceOf(address(router));router.route(address(token));assertEq(rewards.reserve(address(token)),fee);
        assertEq(token.balanceOf(address(router)),0);assertEq(token.balanceOf(0x000000000000000000000000000000000000dEaD),0);
        bytes memory batch=slice(headers,0,24*80);warpHeaders(batch);uint256 g=gasleft();vm.prank(ALICE);r.submit(batch);
        emit log_named_uint("reserve relay first batch gas/header",(g-gasleft())/24);
        uint256 expected=rewards.quote(address(token),16);address[] memory list=one(address(token));
        g=gasleft();vm.prank(FOLDER);idx.fold(16,list);emit log_named_uint("reserve fold one token gas/height",(g-gasleft())/16);
        assertEq(rewards.claimable(address(token),FOLDER),expected);assertEq(rewards.claimable(address(token),ALICE),0);
        assertEq(rewards.reserve(address(token))+rewards.allocated(address(token)),fee);
        g=gasleft();vm.prank(FOLDER);rewards.claim(address(token));emit log_named_uint("reserve claim gas",g-gasleft());
        idx.fold(16);vault.settle();assertEq(vault.currentId(),1);assertGe(token.balanceOf(address(vault)),vault.liabilities());
    }
    function test_rewardBatchGasBudget() public {
        BitcoinRelay r=new BitcoinRelay(cp,798335,uint32(vm.parseJsonUint(meta,".epochStartTime")),1e30,ancestors);
        vm.prank(ALICE);submitAtTime(r,slice(headers,0,80));bytes memory batch=slice(headers,80,24*80);
        warpHeaders(batch);uint256 g=gasleft();vm.prank(ALICE);r.submit(batch);uint256 perHeader=(g-gasleft())/24;
        emit log_named_uint("steady timestamp relay gas/header",perHeader);assertLe(perHeader,100_000);
        batch=slice(headers,25*80,24*80);warpHeaders(batch);g=gasleft();vm.prank(BOB);r.submit(batch);perHeader=(g-gasleft())/24;
        emit log_named_uint("new worker timestamp relay gas/header",perHeader);assertLe(perHeader,100_000);
        assertEq(r.submitter(r.headerAt(798336)),ALICE);assertEq(r.submitter(r.headerAt(798361)),BOB);
    }
    function test_frozenPackingKeepsOriginal70kBudget() public {
        BitcoinRelayPackedBaseline old=new BitcoinRelayPackedBaseline(cp,798335,uint32(vm.parseJsonUint(meta,".epochStartTime")),1e30);
        vm.prank(ALICE);old.submit(slice(headers,0,80));bytes memory batch=slice(headers,80,24*80);
        uint256 g=gasleft();vm.prank(ALICE);old.submit(batch);assertLe((g-gasleft())/24,70_000);
        batch=slice(headers,25*80,24*80);g=gasleft();vm.prank(BOB);old.submit(batch);assertLe((g-gasleft())/24,70_000);
    }
    function test_twoTokenFoldGas() public {
        uint64 nonce=vm.getNonce(address(this));RelayerRewards rewards=new RelayerRewards(vm.computeCreateAddress(address(this),nonce+2),798336);
        BitcoinRelay r=new BitcoinRelay(cp,798335,uint32(vm.parseJsonUint(meta,".epochStartTime")),1e30,ancestors);
        WujiIndex idx=new WujiIndex(r,798336,4320,rewards);MockUSDT a=new MockUSDT();MockUSDT b=new MockUSDT();
        a.mint(address(rewards),1e24);b.mint(address(rewards),1e22);rewards.sync(address(a));rewards.sync(address(b));
        address[] memory list=new address[](2);(list[0],list[1])=address(a)<address(b)?(address(a),address(b)):(address(b),address(a));
        submitAtTime(r,slice(headers,0,48*80));uint256 g=gasleft();vm.prank(FOLDER);idx.fold(16,list);
        emit log_named_uint("reserve fold two tokens gas/height",(g-gasleft())/16);
        assertGt(rewards.claimable(address(a),FOLDER),0);assertGt(rewards.claimable(address(b),FOLDER),0);
    }
    function test_atomicSubmissionCreditsCallerAndCannotBeSplitByFrontRunning() public {
        (RelayerRewards rewards,EasyRelay r,WujiIndex idx)=wired();MockUSDT token=new MockUSDT();
        token.mint(address(rewards),1_000_000);rewards.sync(address(token));
        extend(r,r.bestHash(),6,900);bytes memory h=next(r,r.bestHash(),1000);
        uint256 expected=rewards.quote(address(token),1);
        vm.prank(ALICE);assertEq(idx.submitAndFold(h,16,one(address(token))),1);
        assertEq(rewards.claimable(address(token),ALICE),expected);
        assertEq(rewards.claimable(address(token),address(idx)),0);
        assertEq(r.submitter(r.bestHash()),address(idx)); // Relay observes the immediate caller.
        vm.prank(BOB);assertEq(idx.submitAndFold(h,16,one(address(token))),0);
        assertEq(rewards.claimable(address(token),BOB),0);
    }
    function test_atomicFailureDoesNotCommitHeadersOrRewards() public {
        (RelayerRewards rewards,EasyRelay r,WujiIndex idx)=wired();extend(r,r.bestHash(),6,900);
        bytes32 before=r.bestHash();bytes memory h=next(r,before,1000);
        address[] memory bad=new address[](2);bad[0]=address(1);bad[1]=address(1);
        vm.expectRevert("tokens not sorted unique");idx.submitAndFold(h,16,bad);
        assertEq(r.bestHash(),before);assertEq(idx.lastHeight(),1000);assertEq(rewards.lastHeight(),1000);
    }
    function test_atomicGasSingleAndBatch() public {
        uint64 nonce=vm.getNonce(address(this));RelayerRewards rewards=new RelayerRewards(vm.computeCreateAddress(address(this),nonce+2),798336);
        BitcoinRelay r=new BitcoinRelay(cp,798335,uint32(vm.parseJsonUint(meta,".epochStartTime")),1e30,ancestors);
        WujiIndex idx=new WujiIndex(r,798336,4320,rewards);MockUSDT a=new MockUSDT();MockUSDT b=new MockUSDT();
        a.mint(address(rewards),1e24);b.mint(address(rewards),1e22);rewards.sync(address(a));rewards.sync(address(b));
        address[] memory list=new address[](2);(list[0],list[1])=address(a)<address(b)?(address(a),address(b)):(address(b),address(a));
        submitAtTime(r,slice(headers,0,6*80));bytes memory h=slice(headers,6*80,80);
        warpHeaders(h);uint256 g=gasleft();vm.prank(FOLDER);idx.submitAndFold(h,16,list);
        emit log_named_uint("atomic first one-height two-token execution gas",g-gasleft());
        h=slice(headers,7*80,80);warpHeaders(h);g=gasleft();vm.prank(FOLDER);idx.submitAndFold(h,16,list);
        emit log_named_uint("atomic repeat one-height two-token execution gas",g-gasleft());
        h=slice(headers,8*80,16*80);warpHeaders(h);g=gasleft();vm.prank(FOLDER);idx.submitAndFold(h,16,list);
        emit log_named_uint("atomic batch16 two-token execution gas/height",(g-gasleft())/16);
    }
    function test_alternatingWorkersKeepAttributionAndDuplicatesDoNotSteal() public {
        (RelayerRewards rewards,EasyRelay r,WujiIndex idx)=wired();MockUSDT token=new MockUSDT();token.mint(address(rewards),1_000_000);rewards.sync(address(token));
        bytes memory first;
        for(uint256 i;i<20;++i){bytes memory h=next(r,r.bestHash(),10000+i);if(i==0)first=h;vm.prank(i%2==0?ALICE:BOB);submitAtTime(r,h);}
        vm.prank(BOB);submitAtTime(r,first);
        for(uint64 h=1001;h<=1020;++h)assertEq(r.submitter(r.headerAt(h)),h%2==1?ALICE:BOB);
        assertEq(r.submitter(bytes32(uint256(123))),address(0));assertEq(r.submitter(r.checkpointHash()),address(0));
        uint256 expected=rewards.quote(address(token),14);vm.prank(FOLDER);idx.fold(16,one(address(token)));
        assertEq(rewards.claimable(address(token),ALICE),0);assertEq(rewards.claimable(address(token),BOB),0);
        assertEq(rewards.claimable(address(token),FOLDER),expected);
    }
}
