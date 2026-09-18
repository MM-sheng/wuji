// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice One half of a WUJI pair for one series (YANG-k or YIN-k). Only the vault mints and burns.
contract SeriesToken is ERC20 {
    address public immutable vault;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        vault = msg.sender;
    }

    modifier onlyVault() {
        require(msg.sender == vault, "vault only");
        _;
    }

    function mint(address to, uint256 amount) external onlyVault {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyVault {
        _burn(from, amount);
    }
}
