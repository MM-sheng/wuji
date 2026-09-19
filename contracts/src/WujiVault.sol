// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {WujiIndex} from "./WujiIndex.sol";
import {SeriesToken} from "./SeriesToken.sol";

/// @title WujiVault — 无极生太极，太极生两仪
/// @notice Deposit NOTIONAL of collateral, receive one YANG and one YIN of the current series.
///         At every moment  value(YANG) + value(YIN) == NOTIONAL,  so the vault can never owe more
///         than it holds. Nobody is anyone's counterparty except the other half of their own pair.
///
///         Within a series:   yangShare = ½ + ½·(S_now − S_start)         clamped to [0, 1]
///         so each block moves ½·r_block of the notional from the losing side to the winning side —
///         a FIXED base, which is the only transfer rule that keeps the pair summing to NOTIONAL.
///
///         A series lasts SERIES_LENGTH. After expiry anyone may settle(): the share is frozen from the
///         index and the next series opens at ½/½ with S_start = the settlement S. Settled tokens redeem
///         individually at their frozen value; pairs of the same series always redeem for NOTIONAL.
///
///         No owner. No pause. No upgrade. Fee and treasury are immutable.
contract WujiVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant WAD = 1e18;
    uint256 public constant FEE_BPS = 5;              // 0.05 % on mint and on redeem
    uint256 public constant SERIES_LENGTH = 30 days;

    IERC20 public immutable asset;                    // collateral (e.g. USDT)
    WujiIndex public immutable index;
    uint256 public immutable NOTIONAL;                // collateral per pair (e.g. 100e18)
    address public immutable treasury;                // where fees go; set once, forever

    struct Series {
        SeriesToken yang;
        SeriesToken yin;
        int256 s0;              // index S (wad) at open
        uint64 start;
        uint64 expiry;
        bool settled;
        uint256 yangShare;      // wad share of NOTIONAL owed per YANG after settlement; yin = WAD − yangShare
    }
    Series[] public series;

    event SeriesOpened(uint256 indexed id, address yang, address yin, int256 s0, uint64 expiry);
    event SeriesSettled(uint256 indexed id, int256 s1, uint256 yangShare);
    event Minted(uint256 indexed id, address indexed to, uint256 pairs, uint256 collateral, uint256 fee);
    event RedeemedPair(uint256 indexed id, address indexed from, uint256 pairs, uint256 collateral, uint256 fee);
    event RedeemedSettled(uint256 indexed id, address indexed from, uint256 yang, uint256 yin, uint256 collateral, uint256 fee);

    constructor(IERC20 asset_, WujiIndex index_, uint256 notional_, address treasury_) {
        require(notional_ >= 1e6, "notional too small");
        require(treasury_ != address(0), "treasury");
        asset = asset_;
        index = index_;
        NOTIONAL = notional_;
        treasury = treasury_;
        index_.tick();
        _open(index_.S());
    }

    // ---------------------------------------------------------------- views

    function currentId() public view returns (uint256) {
        return series.length - 1;
    }

    /// @notice Live YANG share (wad) of the current series, as of the index's last folded block.
    function yangShare() public view returns (uint256) {
        Series storage s = series[currentId()];
        if (s.settled) return s.yangShare;
        return _share(s.s0, index.S());
    }

    /// @notice Live collateral value of one YANG and one YIN of the current series.
    function values() external view returns (uint256 yangValue, uint256 yinValue) {
        uint256 sh = yangShare();
        yangValue = NOTIONAL * sh / WAD;
        yinValue = NOTIONAL - yangValue;
    }

    /// @notice Everything the vault owes across all series, at current/settled values. Always ≤ balance.
    function liabilities() external view returns (uint256 total) {
        for (uint256 i = 0; i < series.length; i++) {
            Series storage s = series[i];
            uint256 ys = s.yang.totalSupply();
            uint256 ns = s.yin.totalSupply();
            if (!s.settled) {
                // open series only ever holds matched pairs
                total += ys * NOTIONAL / WAD;
            } else {
                total += _value(ys, s.yangShare) + _value(ns, WAD - s.yangShare);
            }
        }
    }

    // ---------------------------------------------------------------- mint / redeem (open series)

    /// @notice Mint `pairs` (wad) of YANG+YIN in the current series. Pulls pairs·NOTIONAL + fee.
    function mint(uint256 pairs) external nonReentrant returns (uint256 id) {
        require(pairs > 0, "zero");
        id = currentId();
        Series storage s = series[id];
        require(block.timestamp < s.expiry, "series expired: settle first");
        // no index.tick() here: pairs are minted at par, so S is irrelevant, and folding an unbounded
        // number of blocks would make users' gas estimates stale by the time the tx mines.
        uint256 collateral = _ceilMul(pairs, NOTIONAL);
        uint256 fee = _ceilBps(collateral);
        asset.safeTransferFrom(msg.sender, address(this), collateral);
        if (fee > 0) asset.safeTransferFrom(msg.sender, treasury, fee);
        s.yang.mint(msg.sender, pairs);
        s.yin.mint(msg.sender, pairs);
        emit Minted(id, msg.sender, pairs, collateral, fee);
    }

    /// @notice Burn `pairs` of YANG and YIN of series `id` (open or settled) and receive pairs·NOTIONAL − fee.
    function redeemPair(uint256 id, uint256 pairs) external nonReentrant {
        require(pairs > 0, "zero");
        Series storage s = series[id];
        s.yang.burn(msg.sender, pairs);
        s.yin.burn(msg.sender, pairs);
        uint256 collateral = pairs * NOTIONAL / WAD;
        uint256 fee = collateral * FEE_BPS / 10_000;
        asset.safeTransfer(msg.sender, collateral - fee);
        if (fee > 0) asset.safeTransfer(treasury, fee);
        emit RedeemedPair(id, msg.sender, pairs, collateral, fee);
    }

    // ---------------------------------------------------------------- settlement

    /// @notice Freeze the current series at the index's value and open the next one. Anyone, after expiry.
    /// @dev Calls index.tick() first; send with a generous gas limit (≈400k + tick backlog), estimates go stale fast.
    function settle() external nonReentrant returns (uint256 settledId, uint256 nextId) {
        settledId = currentId();
        Series storage s = series[settledId];
        require(block.timestamp >= s.expiry, "not expired");
        index.tick();
        int256 s1 = index.S();
        s.settled = true;
        s.yangShare = _share(s.s0, s1);
        emit SeriesSettled(settledId, s1, s.yangShare);
        nextId = _open(s1);
    }

    /// @notice Redeem settled tokens one-sided at their frozen values.
    function redeemSettled(uint256 id, uint256 yangAmt, uint256 yinAmt) external nonReentrant {
        Series storage s = series[id];
        require(s.settled, "not settled");
        require(yangAmt > 0 || yinAmt > 0, "zero");
        uint256 collateral;
        if (yangAmt > 0) {
            s.yang.burn(msg.sender, yangAmt);
            collateral += _value(yangAmt, s.yangShare);
        }
        if (yinAmt > 0) {
            s.yin.burn(msg.sender, yinAmt);
            collateral += _value(yinAmt, WAD - s.yangShare);
        }
        uint256 fee = collateral * FEE_BPS / 10_000;
        if (collateral - fee > 0) asset.safeTransfer(msg.sender, collateral - fee);
        if (fee > 0) asset.safeTransfer(treasury, fee);
        emit RedeemedSettled(id, msg.sender, yangAmt, yinAmt, collateral, fee);
    }

    // ---------------------------------------------------------------- internals

    function _open(int256 s0) internal returns (uint256 id) {
        id = series.length;
        string memory n = _toString(id);
        SeriesToken yang = new SeriesToken(string.concat("WUJI Yang #", n), string.concat("YANG-", n));
        SeriesToken yin = new SeriesToken(string.concat("WUJI Yin #", n), string.concat("YIN-", n));
        uint64 expiry = uint64(block.timestamp + SERIES_LENGTH);
        series.push(Series({yang: yang, yin: yin, s0: s0, start: uint64(block.timestamp), expiry: expiry, settled: false, yangShare: 0}));
        emit SeriesOpened(id, address(yang), address(yin), s0, expiry);
    }

    /// @dev share = ½ + ½·ΔS, ΔS in wad, clamped to [0, WAD]. Both sides bounded; nothing created or destroyed.
    function _share(int256 s0, int256 s1) internal pure returns (uint256) {
        int256 sh = int256(WAD / 2) + (s1 - s0) / 2;
        if (sh <= 0) return 0;
        if (sh >= int256(WAD)) return WAD;
        return uint256(sh);
    }

    /// @dev collateral owed for `amount` (wad) tokens worth `share` (wad) of NOTIONAL each; rounds down
    function _value(uint256 amount, uint256 share) internal view returns (uint256) {
        return amount * NOTIONAL * share / (WAD * WAD);
    }

    function _ceilMul(uint256 pairs, uint256 notional) internal pure returns (uint256) {
        return (pairs * notional + WAD - 1) / WAD;
    }

    function _ceilBps(uint256 x) internal pure returns (uint256) {
        return (x * FEE_BPS + 9_999) / 10_000;
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 t = v; uint256 d;
        while (t != 0) { d++; t /= 10; }
        bytes memory b = new bytes(d);
        while (v != 0) { b[--d] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(b);
    }
}
