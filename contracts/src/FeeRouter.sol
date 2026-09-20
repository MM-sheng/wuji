// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RelayerRewards} from "./RelayerRewards.sol";
/// @notice Permissionlessly donate 100% of vault fees to the immutable operations reserve.
contract FeeRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant REWARD_BPS = 10_000;
    RelayerRewards public immutable rewards;
    event Routed(address indexed token, uint256 amount);
    constructor(RelayerRewards rewards_) { require(address(rewards_).code.length != 0, "rewards not contract"); rewards = rewards_; }
    function route(address token) external nonReentrant {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) return;
        IERC20(token).forceApprove(address(rewards), balance);
        rewards.fund(token, balance);
        IERC20(token).forceApprove(address(rewards), 0);
        emit Routed(token, balance);
    }
}
