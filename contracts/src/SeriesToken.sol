// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice One half of a WUJI pair for one series (YANG-USDT-3, YIN-WBNB-0, …). Only its vault mints and burns.
contract SeriesToken is ERC20 {
    address public immutable vault;

    constructor(string memory name_, string memory symbol_, address vault_) ERC20(name_, symbol_) {
        vault = vault_;
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

/// @notice Stateless deployer so vaults (and the factory that embeds them) stay under the EIP-170 size limit.
///         Anyone can call it; a token is only meaningful to the vault address baked into it.
contract SeriesTokenDeployer {
    function deploy(string calldata name, string calldata symbol, address vault) external returns (SeriesToken) {
        return new SeriesToken(name, symbol, vault);
    }
}
