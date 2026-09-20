// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";
contract AdversarialRewardToken is MockUSDT {
    bool public blocked; bool public surcharge;
    address public callback; bytes public payload; bool public callbackSucceeded;
    function configure(bool block_,bool tax_,address target,bytes memory data) external {blocked=block_;surcharge=tax_;callback=target;payload=data;}
    function _update(address from,address to,uint256 value) internal override {
        require(!blocked,"token blocked");super._update(from,to,value);
        if(from!=address(0)&&to!=address(0)) {
            if(surcharge)super._update(from,address(0),1);
            if(callback!=address(0))(callbackSucceeded,)=callback.call(payload);
        }
    }
}
contract RelayerRewardsTest is Test {
    RelayerRewards rewards; FeeRouter router; MockUSDT token;
    address constant INDEX=address(2); address constant ALICE=address(3); address constant BOB=address(4);
    address constant DEAD=0x000000000000000000000000000000000000dEaD;
    function setUp() public {rewards=new RelayerRewards(INDEX,1000);router=new FeeRouter(rewards);token=new MockUSDT();}
    function one(address t) internal pure returns(address[] memory list) {list=new address[](1);list[0]=t;}
    function work(address worker,uint64 count,address[] memory list) internal {
        uint64 from=rewards.lastHeight()+1;vm.prank(INDEX);rewards.credit(worker,from,from+count-1,list);
    }
    function fund(uint256 amount) internal {token.mint(address(router),amount);router.route(address(token));}
    function claim(address worker) internal returns(uint256) {vm.prank(worker);return rewards.claim(address(token));}
    function test_onlyIndexAndContiguousNewHeights() public {
        address[] memory list=one(address(token));
        vm.expectRevert("index only");rewards.credit(ALICE,1000,1000,list);work(ALICE,1,list);
        vm.expectRevert("height order");vm.prank(INDEX);rewards.credit(ALICE,1000,1000,list);
        vm.expectRevert("height order");vm.prank(INDEX);rewards.credit(ALICE,1002,1002,list);
        assertEq(rewards.lastHeight(),1000);
    }
    function test_oldWorkCannotClaimNewFees() public {
        work(ALICE,10,one(address(token)));fund(1_000_000);
        assertEq(claim(ALICE),0);assertEq(rewards.reserve(address(token)),1_000_000);
        work(BOB,1,one(address(token)));assertEq(claim(BOB),100);assertEq(claim(ALICE),0);assertEq(claim(BOB),0);
    }
    function test_delayedClaimIsFixedAndCannotTakeLaterFunding() public {
        fund(1_000_000);work(ALICE,1,one(address(token)));
        uint256 fixedAmount=rewards.claimable(address(token),ALICE);assertEq(fixedAmount,100);
        fund(9_000_000);work(BOB,1,one(address(token)));
        assertEq(claim(ALICE),fixedAmount);assertEq(claim(BOB),999);assertEq(claim(ALICE),0);
    }
    function test_unsynchronizedDonationOnlyFundsFutureWork() public {
        token.mint(address(rewards),1_000_000);work(ALICE,1,one(address(token)));assertEq(claim(ALICE),0);
        rewards.sync(address(token));work(BOB,1,one(address(token)));assertEq(claim(ALICE),0);assertEq(claim(BOB),100);
    }
    function test_unselectedTokensCannotBeClaimedRetroactively() public {
        fund(1_000_000);work(ALICE,5,new address[](0));work(BOB,1,one(address(token)));
        assertEq(claim(ALICE),0);assertEq(claim(BOB),100);
    }
    function test_permissionlessFundingDoesNotGiveRights() public {
        token.mint(BOB,1_000_000);vm.startPrank(BOB);token.approve(address(rewards),1_000_000);
        rewards.fund(address(token),1_000_000);vm.stopPrank();work(ALICE,1,one(address(token)));
        assertEq(claim(BOB),0);assertEq(claim(ALICE),100);
    }
    function test_tokenAndHeightBoundsAndDuplicatesRevertAtomically() public {
        address[] memory list=new address[](2);list[0]=address(token);list[1]=address(token);
        vm.expectRevert("tokens not sorted unique");work(ALICE,1,list);assertEq(rewards.lastHeight(),999);
        list[0]=address(2);list[1]=address(1);vm.expectRevert("tokens not sorted unique");work(ALICE,1,list);
        vm.expectRevert("tokens not sorted unique");work(ALICE,1,one(address(0)));
        vm.expectRevert("token limit");work(ALICE,1,new address[](9));
        vm.expectRevert("height limit");work(ALICE,257,one(address(token)));
        vm.expectRevert("height limit");rewards.quote(address(token),257);assertEq(rewards.lastHeight(),999);
    }
    function test_tinyReservePaysZeroAndPreservesEveryUnit() public {
        fund(1);assertEq(token.balanceOf(address(router)),0);assertEq(token.balanceOf(DEAD),0);
        work(ALICE,256,one(address(token)));assertEq(claim(ALICE),0);assertEq(rewards.reserve(address(token)),1);
        fund(9999);work(BOB,256,one(address(token)));assertEq(claim(BOB),1);assertEq(rewards.reserve(address(token)),9999);
    }
    function test_independentTokensAndNoTokenCallsDuringCredit() public {
        AdversarialRewardToken bad=new AdversarialRewardToken();bad.mint(address(rewards),1_000_000);
        rewards.sync(address(bad));bad.configure(true,false,address(0),"");fund(2_000_000);
        address[] memory list=new address[](2);
        (list[0],list[1])=address(token)<address(bad)?(address(token),address(bad)):(address(bad),address(token));
        work(ALICE,1,list);assertEq(rewards.claimable(address(bad),ALICE),100);
        vm.expectRevert("token blocked");vm.prank(ALICE);rewards.claim(address(bad));
        assertEq(claim(ALICE),200);assertEq(rewards.claimable(address(bad),ALICE),100);
        bad.configure(false,false,address(0),"");vm.prank(ALICE);assertEq(rewards.claim(address(bad)),100);
    }
    function test_senderFeeCannotEatOtherWorkersReserveOnClaim() public {
        AdversarialRewardToken bad=new AdversarialRewardToken();bad.mint(address(rewards),1_000_000);rewards.sync(address(bad));
        work(ALICE,1,one(address(bad)));bad.configure(false,true,address(0),"");
        vm.expectRevert("unsupported collateral");vm.prank(ALICE);rewards.claim(address(bad));
        assertEq(rewards.claimable(address(bad),ALICE),100);assertEq(bad.balanceOf(address(rewards)),1_000_000);
    }
    function test_reentrancyBlockedDuringFundingAndClaim() public {
        AdversarialRewardToken bad=new AdversarialRewardToken();bad.mint(address(this),1_000_000);bad.approve(address(rewards),1_000_000);
        bad.configure(false,false,address(rewards),abi.encodeCall(rewards.sync,(address(bad))));
        rewards.fund(address(bad),1_000_000);assertFalse(bad.callbackSucceeded());work(ALICE,1,one(address(bad)));
        bad.configure(false,false,address(rewards),abi.encodeCall(rewards.claim,(address(bad))));
        vm.prank(ALICE);assertEq(rewards.claim(address(bad)),100);assertFalse(bad.callbackSucceeded());
    }
    function test_balanceReductionIsDetectedWithoutErasingClaims() public {
        fund(1_000_000);work(ALICE,1,one(address(token)));vm.prank(address(rewards));token.transfer(BOB,1);
        vm.expectRevert("unsupported balance decrease");rewards.sync(address(token));
        vm.expectRevert("unsupported balance decrease");claim(ALICE);assertEq(rewards.claimable(address(token),ALICE),100);
    }
    function testFuzz_batchSplittingPaysExactlyTheSame(uint128 amount,uint8 n) public {
        uint64 count=uint64(n)+1;fund(amount);uint256 quote=rewards.quote(address(token),count);uint256 snap=vm.snapshotState();
        work(ALICE,count,one(address(token)));uint256 bulk=claim(ALICE);uint256 remaining=rewards.reserve(address(token));
        vm.revertToState(snap);for(uint64 i;i<count;++i)work(ALICE,1,one(address(token)));
        assertEq(claim(ALICE),bulk);assertEq(bulk,quote);assertEq(rewards.reserve(address(token)),remaining);
        assertEq(remaining+bulk,amount);assertEq(token.balanceOf(address(router)),0);assertEq(token.balanceOf(DEAD),0);
    }
}
