// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDT is ERC20("Mock USDT", "USDT") {
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
