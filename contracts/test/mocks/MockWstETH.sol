// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Non-rebasing yield token: balances never change, the ETH value per token rises.
contract MockWstETH is ERC20("Mock wstETH", "wstETH") {
    uint256 public stEthPerToken = 1e18;
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function accrue(uint256 bps) external { stEthPerToken = stEthPerToken * (10_000 + bps) / 10_000; }
    function getStETHByWstETH(uint256 amount) external view returns (uint256) { return amount * stEthPerToken / 1e18; }
}
