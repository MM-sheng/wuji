// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";
contract RewardHandler is Test {
    RelayerRewards public rewards;
    FeeRouter public router;
    MockUSDT[2] public tokens;
    uint256[2] public fees;
    constructor() {
        rewards = new RelayerRewards(address(this), address(0x1234)); router = new FeeRouter(rewards);
        tokens[0] = new MockUSDT(); tokens[1] = new MockUSDT();
    }
    function credit(uint256 who, uint256 amount) external { rewards.credit(address(uint160(100+who%3)), bound(amount,1,1000)); }
    function fee(uint256 which, uint256 amount) external {
        which %= 2; amount = bound(amount,0,1e24); fees[which] += amount;
        tokens[which].mint(address(router),amount); router.route(address(tokens[which]));
    }
    function claim(uint256 which, uint256 who, uint256 count) external {
        vm.prank(address(uint160(100+who%3))); rewards.claim(address(tokens[which%2]), bound(count,1,8));
    }
}
contract RelayerRewardsInvariants is Test {
    RewardHandler handler;
    function setUp() public { handler = new RewardHandler(); targetContract(address(handler)); }
    function invariant_feeConservation() public view {
        for (uint256 t; t < 2; ++t) {
            MockUSDT token = handler.tokens(t); FeeRouter router = handler.router();
            uint256 sum = token.balanceOf(address(router)) + token.balanceOf(address(handler.rewards())) + token.balanceOf(router.DEAD());
            for(uint160 i = 100; i < 103; ++i) sum += token.balanceOf(address(i));
            assertEq(sum, handler.fees(t));
            assertLe(token.balanceOf(address(router)),1);
            assertEq(token.balanceOf(router.DEAD()),handler.fees(t)/2);
        }
    }
}
