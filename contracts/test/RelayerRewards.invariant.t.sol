// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";
contract RewardHandler is Test {
    RelayerRewards public rewards; FeeRouter public router;
    MockUSDT[2] public tokens; uint256[2] public funding;
    uint256[3][2] public earned; uint256[3][2] public paid;
    constructor() {
        rewards=new RelayerRewards(address(this),1000);router=new FeeRouter(rewards);
        tokens[0]=new MockUSDT();tokens[1]=new MockUSDT();
    }
    function credit(uint256 who,uint256 count,uint256 mask) external {
        who%=3;count=bound(count,1,32);mask%=4;
        address[] memory list=new address[]((mask&1)+(mask>>1));uint256 pos;
        for(uint256 t;t<2;++t)if((mask&(1<<t))!=0) {
            list[pos++]=address(tokens[t]);uint256 r=rewards.reserve(address(tokens[t]));
            // Independent accounting model, one height at a time.
            for(uint256 h;h<count;++h){uint256 bounty=r/rewards.BOUNTY_DIVISOR();earned[t][who]+=bounty;r-=bounty;}
        }
        if(list.length==2&&list[0]>list[1])(list[0],list[1])=(list[1],list[0]);
        uint64 from=rewards.lastHeight()+1;rewards.credit(address(uint160(100+who)),from,from+uint64(count)-1,list);
    }
    function fee(uint256 which,uint256 amount) external {
        which%=2;amount=bound(amount,0,1e24);funding[which]+=amount;
        tokens[which].mint(address(router),amount);router.route(address(tokens[which]));
    }
    function donation(uint256 which,uint256 amount) external {
        which%=2;amount=bound(amount,1,1e24);funding[which]+=amount;tokens[which].mint(address(this),amount);
        tokens[which].approve(address(rewards),amount);rewards.fund(address(tokens[which]),amount);
    }
    function claim(uint256 which,uint256 who) external {
        which%=2;who%=3;vm.prank(address(uint160(100+who)));paid[which][who]+=rewards.claim(address(tokens[which]));
    }
}
contract RelayerRewardsInvariants is Test {
    RewardHandler handler;
    function setUp() public {handler=new RewardHandler();targetContract(address(handler));}
    function invariant_reserveClaimsAndPaymentsConserveAllFunding() public view {
        for(uint256 t;t<2;++t){
            MockUSDT token=handler.tokens(t);RelayerRewards rewards=handler.rewards();uint256 claims;uint256 totalPaid;
            for(uint256 i;i<3;++i){
                address worker=address(uint160(100+i));uint256 owed=rewards.claimable(address(token),worker);
                assertEq(owed+handler.paid(t,i),handler.earned(t,i));assertEq(token.balanceOf(worker),handler.paid(t,i));
                claims+=owed;totalPaid+=handler.paid(t,i);
            }
            assertEq(rewards.allocated(address(token)),claims);
            assertEq(rewards.reserve(address(token))+claims,token.balanceOf(address(rewards)));
            assertEq(token.balanceOf(address(rewards))+totalPaid,handler.funding(t));
            assertEq(token.balanceOf(address(handler.router())),0);
            assertEq(token.balanceOf(0x000000000000000000000000000000000000dEaD),0);
        }
    }
}
