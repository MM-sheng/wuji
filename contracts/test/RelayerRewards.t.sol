// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";
contract RelayerRewardsTest is Test {
    RelayerRewards rewards;
    FeeRouter router;
    MockUSDT token;
    address constant RELAY = address(1);
    address constant INDEX = address(2);
    address constant ALICE = address(3);
    address constant BOB = address(4);
    function setUp() public { rewards = new RelayerRewards(RELAY, INDEX); router = new FeeRouter(rewards); token = new MockUSDT(); }
    function credit(address worker, uint256 count) internal { vm.prank(RELAY); rewards.credit(worker, count); }
    function fund(uint256 amount) internal { token.mint(address(router), amount); router.route(address(token)); }
    function claim(address worker) internal returns(uint256) { vm.prank(worker); return rewards.claim(address(token)); }
    function test_onlyImmutableSourcesCanCredit() public {
        vm.expectRevert("unauthorized source"); rewards.credit(ALICE, 1);
        credit(ALICE, 1); vm.prank(INDEX); rewards.credit(BOB, 2);
        assertEq(rewards.totalPoints(), 3);
    }
    function test_newPointsCannotTakePastRewardsAndClaimsDoNotRepeat() public {
        credit(ALICE, 1); fund(200);
        credit(BOB, 1); fund(400);
        assertEq(claim(ALICE), 200); assertEq(claim(BOB), 100);
        assertEq(claim(ALICE), 0); assertEq(claim(BOB), 0);
        assertEq(token.balanceOf(router.DEAD()), 300);
    }
    function test_sameSequenceFundingAndAdditionalLots() public {
        credit(ALICE, 1); fund(200); fund(200);
        credit(ALICE, 1); fund(200);
        assertEq(claim(ALICE), 300);
        credit(BOB, 2); fund(400);
        assertEq(claim(ALICE), 100); assertEq(claim(BOB), 100);
    }
    function test_independentTokensAndPreWorkDonations() public {
        fund(200); assertEq(token.balanceOf(address(rewards)), 100);
        credit(ALICE, 1); rewards.sync(address(token));
        MockUSDT other = new MockUSDT(); other.mint(address(router), 600); router.route(address(other));
        credit(BOB, 1);
        assertEq(claim(ALICE), 100); assertEq(claim(BOB), 0);
        vm.prank(ALICE); assertEq(rewards.claim(address(other)), 300);
        vm.prank(BOB); assertEq(rewards.claim(address(other)), 0);
    }
    function test_boundedClaimsKeepUnprocessedHistory() public {
        for (uint256 i; i < 10; ++i) { credit(ALICE, 1); fund(200); }
        uint256 total;
        for (uint256 i; i < 5; ++i) { vm.prank(ALICE); total += rewards.claim(address(token), 2); }
        assertLe(total, 1000); assertLe(1000-total, 1); // accumulator division reserve
        assertEq(claim(ALICE), 0);
        fund(200); assertEq(claim(ALICE), 100);
    }
    function testFuzz_splitConservation(uint128 amount) public {
        credit(ALICE, 1); fund(amount);
        assertEq(token.balanceOf(address(router)), uint256(amount)%2);
        assertEq(token.balanceOf(address(rewards)), uint256(amount)/2);
        assertEq(token.balanceOf(router.DEAD()), uint256(amount)/2);
        claim(ALICE);
        assertEq(token.balanceOf(address(router)) + token.balanceOf(address(rewards)) + token.balanceOf(router.DEAD()) + token.balanceOf(ALICE), amount);
    }
    function test_fractionalEntitlementsSurviveRepeatedClaims() public {
        credit(ALICE, 1); credit(BOB, 2);
        fund(2); assertEq(claim(ALICE), 0); assertEq(claim(BOB), 0);
        fund(6); assertEq(claim(ALICE), 1); assertEq(claim(BOB), 2);
    }
}
