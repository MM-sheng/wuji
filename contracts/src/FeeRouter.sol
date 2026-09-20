// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RelayerRewards} from "./RelayerRewards.sol";
/// @notice Permissionless 50/50 routing. An odd smallest unit stays here until a later fee arrives.
/// @dev Sending to DEAD does not necessarily reduce an ERC-20's reported totalSupply.
contract FeeRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant REWARD_BPS = 5000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    RelayerRewards public immutable rewards;
    event Routed(address indexed token, uint256 reward, uint256 burned, uint256 dust);
    constructor(RelayerRewards rewards_) { require(address(rewards_).code.length != 0, "rewards not contract"); rewards = rewards_; }
    function route(address token) external nonReentrant {
        uint256 balance = IERC20(token).balanceOf(address(this)); uint256 half = balance / 2;
        if (half == 0) return;
        IERC20(token).safeTransfer(address(rewards), half);
        IERC20(token).safeTransfer(DEAD, half);
        rewards.sync(token);
        emit Routed(token, half, half, balance % 2);
    }
}
