// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {WujiIndex} from "./WujiIndex.sol";
import {SeriesToken, SeriesTokenDeployer} from "./SeriesToken.sol";

/// @title WujiVault — 无极生太极，太极生两仪
/// @notice Deposit NOTIONAL of collateral, receive one YANG and one YIN of the current series.
///         Under ordinary ERC-20 accounting, a pair's gross settlement allocation sums to NOTIONAL.
///         The index S, instantaneous allocation, expiry payoff and executable market price differ.
///         The share is an absolute-position function, independent of the intermediate path:
///         yangShare = clamp(1/2 + (S_now - S_start)/2, 0, 1). It is not a lending price feed.
///
///         Every series ends at a block fixed before its hash exists. After that block anyone may settle():
///         the share is frozen from its index checkpoint and the next series uses that checkpoint as its base. Settled tokens redeem
///         individually at their frozen value; pairs of the same series always redeem for NOTIONAL.
///
///         No owner. No pause. No upgrade. Fee and treasury are immutable.
contract WujiVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant WAD = 1e18;
    uint256 public constant FEE_BPS = 5; // 0.05 % on mint and on redeem

    IERC20 public immutable asset; // collateral (e.g. USDT)
    WujiIndex public immutable index;
    uint256 public immutable NOTIONAL; // collateral per pair (e.g. 100e18)
    address public immutable treasury; // where fees go; set once, forever
    SeriesTokenDeployer public immutable tokens; // stateless helper that deploys YANG/YIN tokens bound to this vault
    string public collateralSymbol; // e.g. "USDT"; baked into series token names

    struct Series {
        SeriesToken yang;
        SeriesToken yin;
        int256 s0; // index S (wad) at open
        uint64 startHeight;
        uint64 settlementHeight;
        bool settled;
        uint256 yangShare; // wad share of NOTIONAL owed per YANG after settlement; yin = WAD − yangShare
    }
    Series[] public series;
    /// @notice Terminal closure after the index's permissionless deep-reorg exit; never reopens.
    bool public closed;

    event SeriesOpened(uint256 indexed id, address yang, address yin, int256 s0, uint64 settlementHeight);
    event SeriesSettled(uint256 indexed id, int256 s1, uint256 yangShare);
    event FrozenSettlement(uint256 indexed id, bool boundaryRecorded, uint256 yangShare);
    event Minted(uint256 indexed id, address indexed to, uint256 pairs, uint256 collateral, uint256 fee);
    event RedeemedPair(uint256 indexed id, address indexed from, uint256 pairs, uint256 collateral, uint256 fee);
    event RedeemedSettled(
        uint256 indexed id, address indexed from, uint256 yang, uint256 yin, uint256 collateral, uint256 fee
    );

    constructor(IERC20 asset_, WujiIndex index_, uint256 notional_, address treasury_, SeriesTokenDeployer tokens_) {
        require(address(tokens_).code.length > 0, "deployer not contract");
        tokens = tokens_;
        require(address(asset_).code.length > 0, "asset not contract");
        require(address(index_).code.length > 0, "index not contract");
        require(notional_ >= 1e6, "notional too small");
        require(treasury_ != address(0), "treasury");
        asset = asset_;
        index = index_;
        NOTIONAL = notional_;
        treasury = treasury_;
        collateralSymbol = _symbolOf(address(asset_));
        // Fold at most a small backlog here: an unbounded fold would make vault creation cost arbitrary gas
        // (a 1024-block history fold is ~6M). With a larger backlog, advance the index first, then create.
        require(index_.pending() <= 256, "index backlog: fold first");
        index_.fold(256);
        uint64 boundary = index_.nextCheckpointHeight();
        require(boundary > index_.lastHeight(), "index stale: fold first");
        _open(index_.S(), index_.GENESIS_HEIGHT(), boundary);
    }

    // ---------------------------------------------------------------- views

    function currentId() public view returns (uint256) {
        return series.length - 1;
    }

    function currentSettlementHeight() external view returns (uint64) {
        return series[currentId()].settlementHeight;
    }

    /// @notice Live YANG share (wad) of the current series, as of the index's last folded block.
    function yangShare() public view returns (uint256) {
        Series storage s = series[currentId()];
        if (s.settled) return s.yangShare;
        int256 s1 = index.checkpointed(s.settlementHeight) ? index.checkpointS(s.settlementHeight) : index.S();
        return _share(s.s0, s1);
    }

    /// @notice Gross settlement allocations, NOT market prices or early single-sided redemption quotes.
    function values() external view returns (uint256 yangValue, uint256 yinValue) {
        uint256 sh = yangShare();
        yangValue = NOTIONAL * sh / WAD;
        yinValue = NOTIONAL - yangValue;
    }

    /// @notice All series liabilities in collateral units; covered under ordinary ERC-20 accounting assumptions.
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
        _requireActive();
        require(pairs > 0, "zero");
        id = currentId();
        Series storage s = series[id];
        require(index.lastHeight() < s.settlementHeight, "series ended: settle first");
        // no index.fold() here: pairs are minted at par, so S is irrelevant, and folding an unbounded
        // number of blocks would make users' gas estimates stale by the time the tx mines.
        uint256 collateral = _ceilMul(pairs, NOTIONAL);
        uint256 fee = _ceilBps(collateral);
        uint256 beforeBalance = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), collateral);
        require(asset.balanceOf(address(this)) - beforeBalance == collateral, "unsupported collateral");
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

    /// @notice Freeze the current series at its predetermined index checkpoint and open the next one.
    /// @dev If the checkpoint is more than one default fold away, advance WujiIndex separately first.
    function settle() external nonReentrant returns (uint256 settledId, uint256 nextId) {
        _requireActive();
        settledId = currentId();
        Series storage s = series[settledId];
        uint64 boundary = s.settlementHeight;
        require(index.finalizedHeight() >= boundary, "settlement height not final");
        if (!index.checkpointed(boundary)) {
            uint64 last = index.lastHeight();
            require(last < boundary && boundary - last <= index.DEFAULT_MAX(), "index backlog: fold first");
            index.fold();
            require(index.checkpointed(boundary), "checkpoint unavailable");
        }
        int256 s1 = index.checkpointS(boundary);
        s.settled = true;
        s.yangShare = _share(s.s0, s1);
        emit SeriesSettled(settledId, s1, s.yangShare);
        nextId = _open(s1, boundary + 1, boundary + index.CHECKPOINT_INTERVAL());
    }

    /// @notice Close the current series without opening another after the index is permanently frozen.
    /// @dev Each series contains at most its own end checkpoint. Earlier/later checkpoints cannot replace it.
    ///      Preserve a recorded end payoff; otherwise split at 1/2. Previously settled claims never change.
    function settleFrozen() external nonReentrant returns (uint256 settledId) {
        require(!closed, "vault closed");
        require(index.frozen(), "index not frozen");
        settledId = currentId();
        Series storage s = series[settledId];
        bool recorded = index.checkpointed(s.settlementHeight);
        uint256 share = recorded ? _share(s.s0, index.checkpointS(s.settlementHeight)) : WAD / 2;
        closed = true;
        s.settled = true;
        s.yangShare = share;
        emit FrozenSettlement(settledId, recorded, share);
    }

    /// @notice Redeem settled tokens one-sided at their frozen values.
    function redeemSettled(uint256 id, uint256 yangAmt, uint256 yinAmt) external nonReentrant {
        Series storage s = series[id];
        require(s.settled, "not settled");
        require(yangAmt > 0 || yinAmt > 0, "zero");
        uint256 collateral = 0;
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

    function _requireActive() internal view {
        require(!closed, "vault closed");
        require(!index.frozen(), "index frozen");
        require(index.historyConsistent(), "deep Bitcoin reorg");
    }

    function _open(int256 s0, uint64 startHeight, uint64 settlementHeight) internal returns (uint256 id) {
        id = series.length;
        string memory n = _toString(id);
        string memory c = collateralSymbol;
        SeriesToken yang = tokens.deploy(string.concat("WUJI Yang ", c, " #", n), string.concat("YANG-", c, "-", n), address(this));
        SeriesToken yin = tokens.deploy(string.concat("WUJI Yin ", c, " #", n), string.concat("YIN-", c, "-", n), address(this));
        series.push(
            Series({
                yang: yang,
                yin: yin,
                s0: s0,
                startHeight: startHeight,
                settlementHeight: settlementHeight,
                settled: false,
                yangShare: 0
            })
        );
        emit SeriesOpened(id, address(yang), address(yin), s0, settlementHeight);
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

    /// @dev symbol() is optional in ERC-20; fall back to a generic tag so names never revert
    function _symbolOf(address a) internal view returns (string memory) {
        (bool ok, bytes memory r) = a.staticcall(abi.encodeWithSelector(IERC20Metadata.symbol.selector));
        if (ok && r.length >= 64) {
            string memory sym = abi.decode(r, (string));
            if (bytes(sym).length > 0 && bytes(sym).length <= 11) return sym;
        }
        return "TOKEN";
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 t = v;
        uint256 d = 0;
        while (t != 0) {
            d++;
            t /= 10;
        }
        bytes memory b = new bytes(d);
        while (v != 0) {
            b[--d] = bytes1(uint8(48 + v % 10));
            v /= 10;
        }
        return string(b);
    }
}
