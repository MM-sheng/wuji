// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WujiIndex} from "./WujiIndex.sol";
import {WujiAccounts} from "./WujiAccounts.sol";

/// @notice The volatility menu, fixed forever: one pool per (collateral, tier), created once, by anyone.
/// A fixed menu keeps liquidity in few pools; a free slider would split it into pools nobody matches.
contract WujiAccountsFactory {
    // S moves ≈115% per year; pool annual vol ≈ 115% / K.
    int256 public constant K_5 = 23e18;    //  5% per year
    int256 public constant K_10 = 11.5e18; // 10% per year
    int256 public constant K_25 = 4.6e18;  // 25% per year
    uint256 public constant TIERS = 3;

    WujiIndex public immutable index;
    address public immutable treasury;
    uint64 public immutable EPOCH;
    uint64 public immutable DELAY;
    uint256 public immutable FEE_BPS;
    uint256 public immutable BUFFER_BPS;

    mapping(address => WujiAccounts[3]) internal pools;
    event Created(address indexed asset, uint256 tier, int256 k, address pool, uint256 bounty);

    constructor(WujiIndex index_, address treasury_, uint64 epoch, uint64 delay, uint256 feeBps, uint256 bufferBps) {
        index = index_; treasury = treasury_; EPOCH = epoch; DELAY = delay; FEE_BPS = feeBps; BUFFER_BPS = bufferBps;
    }

    function kOf(uint256 tier) public pure returns (int256) {
        return [K_5, K_10, K_25][tier];
    }

    /// @notice Create the three pools for `asset`. `bounty` is in asset units (chosen by the creator because
    /// only they know the token's decimals and value); it is capped by what the buffer holds, never more.
    function create(IERC20 asset, uint256 bounty) external returns (WujiAccounts[3] memory created) {
        require(address(pools[address(asset)][0]) == address(0), "exists");
        for (uint256 t; t < TIERS; t++) {
            created[t] = new WujiAccounts(WujiAccounts.Config(
                asset, index, kOf(t), EPOCH, DELAY, treasury, FEE_BPS, bounty, BUFFER_BPS));
            pools[address(asset)][t] = created[t];
            emit Created(address(asset), t, kOf(t), address(created[t]), bounty);
        }
    }

    function pool(address asset, uint256 tier) external view returns (WujiAccounts) {
        return pools[asset][tier];
    }
}
