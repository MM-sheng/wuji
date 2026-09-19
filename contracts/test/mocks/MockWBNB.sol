// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockWBNB is ERC20("Wrapped BNB", "WBNB") {
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
