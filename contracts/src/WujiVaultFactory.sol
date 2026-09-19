// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WujiIndex} from "./WujiIndex.sol";
import {WujiVault} from "./WujiVault.sol";
import {SeriesTokenDeployer} from "./SeriesToken.sol";

/// @title WujiVaultFactory — one index, any collateral
/// @notice Anyone may open a vault for any ERC-20 with any notional. Every vault reads the same WujiIndex,
///         so every collateral sees the same path and settles at the same checkpoints; the collateral only
///         decides what YANG + YIN adds up to. No admin, no allow-list: the chain is neutral, curation is
///         the front-end's job.
/// @dev    Fee-on-transfer and rebasing tokens break the vault's solvency accounting. The vault rejects
///         fee-on-transfer mints atomically; rebasing tokens must simply not be used.
contract WujiVaultFactory {
    WujiIndex public immutable index;
    address public immutable treasury;
    SeriesTokenDeployer public immutable tokens;

    WujiVault[] public vaults;
    /// @notice canonical vault per (asset, notional); prevents duplicates of the same market
    mapping(address => mapping(uint256 => WujiVault)) public vaultFor;

    event VaultCreated(uint256 indexed id, address indexed asset, uint256 notional, address vault, string symbol);

    constructor(WujiIndex index_, address treasury_, SeriesTokenDeployer tokens_) {
        require(address(index_).code.length > 0, "index not contract");
        require(address(tokens_).code.length > 0, "deployer not contract");
        require(treasury_ != address(0), "treasury");
        index = index_;
        treasury = treasury_;
        tokens = tokens_;
    }

    /// @notice Deploy the vault for `asset` with `notional` collateral per pair. Reverts if it already exists.
    function create(IERC20 asset, uint256 notional) external returns (WujiVault vault) {
        require(address(vaultFor[address(asset)][notional]) == address(0), "exists");
        vault = new WujiVault(asset, index, notional, treasury, tokens);
        vaultFor[address(asset)][notional] = vault;
        vaults.push(vault);
        emit VaultCreated(vaults.length - 1, address(asset), notional, address(vault), vault.collateralSymbol());
    }

    function count() external view returns (uint256) {
        return vaults.length;
    }
}
