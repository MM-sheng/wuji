// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WujiIndex} from "./WujiIndex.sol";
import {WujiAccounts} from "./WujiAccounts.sol";

/// @notice The volatility menu, fixed forever: one pool per tier, created once, by anyone, all in one collateral.
/// A fixed menu keeps liquidity in few pools; a free slider would split it into pools nobody matches.
/// One collateral keeps the menu's exposure to S bounded: each tier's per-side cap is K · EXPOSURE_BUDGET / 3,
/// so Σ cap / K over the menu is EXPOSURE_BUDGET (asset units per unit of S) in era CAP_ERA, halving after
/// (docs/decisions/2026-10-06-pool-exposure.md). Mainnet uses WETH: no issuer can freeze it.
contract WujiAccountsFactory {
    // S moves ≈115% per year; pool annual vol ≈ 115% / K.
    int256 internal constant K_5 = 23e18;    //  5% per year
    int256 internal constant K_10 = 11.5e18; // 10% per year
    int256 internal constant K_25 = 4.6e18;  // 25% per year
    uint256 public constant TIERS = 3;
    /// @notice Keeper bounty per processed epoch or retirement: 1/10000 of the pool's buffer.
    uint256 internal constant BOUNTY_DIVISOR = 10_000;

    // Pricing and fee parameters are internal here: every pool exposes its own copy.
    WujiIndex public immutable index;
    address public immutable treasury;
    uint64 internal immutable EPOCH;
    uint64 internal immutable DELAY;
    uint256 internal immutable MAX_TIP_AGE;
    uint256 internal immutable FEE_BPS;
    uint256 internal immutable BUFFER_BPS;
    IERC20 public immutable ASSET;
    uint256 public immutable EXPOSURE_BUDGET;
    uint64 public immutable CAP_ERA;

    WujiAccounts[3] internal pools;
    event Created(address indexed asset, uint256 tier, int256 k, address pool);

    constructor(
        WujiIndex index_, address treasury_, uint64 epoch, uint64 delay, uint256 maxTipAge, uint256 feeBps,
        uint256 bufferBps, IERC20 asset_, uint256 exposureBudget, uint64 capEra
    ) {
        require(exposureBudget > 0, "budget");
        index = index_; treasury = treasury_; EPOCH = epoch; DELAY = delay; MAX_TIP_AGE = maxTipAge;
        FEE_BPS = feeBps; BUFFER_BPS = bufferBps; ASSET = asset_; EXPOSURE_BUDGET = exposureBudget; CAP_ERA = capEra;
    }

    /// @notice A tier's per-side principal cap in era CAP_ERA.
    function capOf(uint256 tier) public view returns (uint256) {
        return uint256(kOf(tier)) * EXPOSURE_BUDGET / (TIERS * 1e18);
    }

    function kOf(uint256 tier) public pure returns (int256) {
        return [K_5, K_10, K_25][tier];
    }

    /// @notice Create the pool for (`asset`, `tier`), once, by anyone. One pool per call: three pools in one
    /// transaction need ≈ 18.5M gas, above the 2^24 per-transaction gas cap (EIP-7825) on Ethereum and Sepolia.
    function create(IERC20 asset, uint256 tier) external returns (WujiAccounts created) {
        require(asset == ASSET, "collateral");
        require(tier < TIERS, "tier");
        require(address(pools[tier]) == address(0), "exists");
        created = new WujiAccounts(WujiAccounts.Config(
            asset, index, kOf(tier), EPOCH, DELAY, MAX_TIP_AGE, treasury, FEE_BPS, BOUNTY_DIVISOR, BUFFER_BPS,
            capOf(tier), CAP_ERA));
        pools[tier] = created;
        emit Created(address(asset), tier, kOf(tier), address(created));
    }

    function pool(address asset, uint256 tier) external view returns (WujiAccounts) {
        return asset == address(ASSET) ? pools[tier] : WujiAccounts(address(0));
    }
}
