// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {WujiIndex} from "./WujiIndex.sol";

/// @notice What a pool needs from an index that keeps no header relay (ZkWujiIndex): the newest Bitcoin
/// header it has validated, folded or not.
interface IZkTip {
    function seenHeight() external view returns (uint64);
    function seenTime() external view returns (uint32);
}

/// @notice T11 perpetual accounts. Fixed principal, additive P&L = principal·side·ΔS/k, value in
/// [0, 2·principal], no expiry. One collateral and one tier per pool; `WujiAccountsFactory` fixes the menu.
/// See docs/tasks/T11_PERPETUAL_ACCOUNTS.md. No owner, no pause, no upgrade; every parameter is immutable.
/// @dev Every entry and exit is priced at an epoch height that was not yet mined when it was requested.
/// Epochs are processed strictly in order; between processed epochs the pool does not move.
///
/// Where "not yet mined" comes from depends on the index (fixed at construction):
///  C. an index with a header relay (WujiIndex): the relay's best height + DELAY, best header ≤ MAX_TIP_AGE old;
///  S. an index without one (ZkWujiIndex): the newest header the index has validated (`seenHeight`) + a margin
///     that bounds the chance that the pricing block already exists by 1e-7 given that header's age
///     (`seenMargin`). One rule; nothing for the requester to supply (T13).
contract WujiAccounts is ReentrancyGuard {
    using SafeERC20 for IERC20;

    int256 internal constant ONE = 1e18;
    int256 internal constant ACC = 1e27;   // accumulator precision per unit of principal
    uint256 public constant MAX_WALK = 1024;
    /// @notice Pools on an index without a relay refuse requests once its newest validated header is older.
    uint256 public constant MAX_SEEN_AGE = 24 hours;
    /// @dev Margin by the newest validated header's age rounded up to whole hours (0..24 h), as big-endian uint16:
    /// the smallest m with P(Poisson(λ) ≥ m) ≤ 1e-7, λ = 1.25 × 6 blocks/h × (age + 2 h). The 1.25 allows for
    /// blocks faster than one per ten minutes between retargets; the 2 h for header timestamps ahead of real
    /// time. Recompute: docs/tasks/T11_PERPETUAL_ACCOUNTS.md (Update 2026-10-01).
    bytes internal constant MARGINS =
        hex"002800340040004a0055005f00690073007d00870090009a00a300ad00b600bf00c900d200db00e400ed00f600ff01080111";

    IERC20 public immutable asset;
    WujiIndex public immutable index;
    int256 public immutable K;          // wad; annual vol ≈ 115% / K
    uint64 public immutable EPOCH;      // pricing heights are multiples of EPOCH
    uint64 public immutable DELAY;      // pricing height ≥ relay best + DELAY
    /// @notice Requests revert unless the relay's best header is at most this old. Together with DELAY it bounds
    /// the chance that the pricing block already exists when a request lands: at most P(≥ DELAY blocks mined in
    /// MAX_TIP_AGE). 30 min with DELAY 16 gives ≈1e-7 in the worst case (docs/tasks/T11 §Entry and exit timing).
    uint256 public immutable MAX_TIP_AGE;
    /// @notice Whether the index implements the T9 frozen exit. Older indexes (BSC testnet v3) do not; there the
    /// pool simply has no frozen state, and a deep reorg stops new requests and epoch processing instead.
    bool public immutable INDEX_CAN_FREEZE;
    /// @notice Whether the index has a header relay (pricing C). Otherwise the pool prices by A, or B on request.
    bool public immutable RELAY_TIP;
    address public immutable treasury;  // FeeRouter: surplus fees go to the relayers' operations reserve
    uint256 public immutable FEE_BPS;   // charged on entry and on normal exit
    /// @notice Each processed epoch and each retirement pays `buffer / BOUNTY_DIVISOR` to its caller (0 = none).
    /// A share, not a constant, like RelayerRewards: it cannot outgrow the buffer, needs no per-token amount,
    /// and farming it with dust requests drains at most one share per epoch (≈0.24%/day at 1/10000).
    uint256 public immutable BOUNTY_DIVISOR;
    uint256 public immutable BUFFER_BPS; // buffer kept against floor overshoot, relative to live principal
    /// @notice Cap on each side's principal (live plus pending entries) while Bitcoin is in subsidy era CAP_ERA,
    /// halved at every later halving: an entry priced at height h may not lift its side above `capAt(h)`.
    /// A block can move S by at most 4080 · 1.2e-5 and costs its miner a block subsidy, so keeping every pool's
    /// cap / K summed under subsidy / 0.04896 makes discarding or privately mining blocks unprofitable whatever
    /// the outcome; the subsidy halves, so does the cap (docs/decisions/2026-10-06-pool-exposure.md).
    uint256 public immutable MAX_PRINCIPAL;
    uint64 public immutable CAP_ERA;
    uint64 public constant HALVING_INTERVAL = 210_000;

    struct Config {
        IERC20 asset; WujiIndex index; int256 k; uint64 epoch; uint64 delay; uint256 maxTipAge;
        address treasury; uint256 feeBps; uint256 bountyDivisor; uint256 bufferBps;
        uint256 maxPrincipal; uint64 capEra;
    }

    struct Account {
        address owner;
        bool yang;
        uint64 enterEpoch;
        uint64 exitEpoch;   // 0 = open
        uint128 principal;
    }
    struct Epoch {
        uint128[2] enterIn;     // [yin, yang]
        uint128[2] exitOut;
        int256[2] acc;          // accumulators after advancing to this epoch
        bool processed;
        bool frozenRefund;      // entries of this epoch were refunded (priced after the freeze)
    }

    mapping(uint256 => Account) public accounts;
    mapping(uint64 => Epoch) internal epochs;
    uint64[] public queue;
    uint256 public head;
    uint256 public nextId = 1;

    // Pool state as of the last processed epoch.
    uint128[2] public principalOf;   // live principal per side [yin, yang]
    int256[2] public acc;
    int256 public lastS;
    bool public started;
    bool public frozen;
    bool internal afterFallback;
    /// @notice Fees held in the pool: pays bounties and absorbs floor overshoot before anything else.
    uint256 public buffer;
    /// @notice Principal of entries requested but not yet priced. Counted in the buffer target so fees are not
    /// swept away before the accounts they protect have joined the pool.
    uint256 public pendingPrincipal;
    /// @notice The same, per side [yin, yang]: counted against the cap so queued entries cannot overshoot it.
    uint128[2] public pendingIn;
    /// @notice Losses beyond the floor that neither the losing account nor the buffer paid. Winners are still
    /// credited those amounts, so this is the pool's only possible shortfall. It stays zero while the buffer
    /// covers overshoot, which is what `retire` and its bounty are for.
    uint256 public badDebt;
    /// @notice Accounts not yet claimed or retired (pending, open, exiting or frozen).
    uint256 public openAccounts;

    // Index value at arbitrary folded heights, recomputed from relay headers.
    mapping(uint64 => int256) public sAt;
    mapping(uint64 => bool) public marked;
    /// @notice Bitcoin header hash (raw sha256d digest order) at a height marked from supplied headers.
    mapping(uint64 => bytes32) public hashAt;
    /// @notice Lowest height marked on the way down to a queued epoch that was more than MAX_WALK below the tip.
    uint64 public bridge;

    event EnterRequested(uint256 indexed id, address indexed owner, bool yang, uint128 principal, uint64 epoch);
    event ExitRequested(uint256 indexed id, uint64 epoch);
    event EpochProcessed(uint64 indexed epoch, int256 S, int256 accYin, int256 accYang);
    event Claimed(uint256 indexed id, address indexed to, uint256 amount);
    event Retired(uint256 indexed id);
    event Transfer(uint256 indexed id, address indexed from, address indexed to);
    event PoolFrozen(int256 S);
    event Bounty(address indexed to, uint256 amount);
    event BadDebt(uint256 debt, uint256 absorbed);
    event Swept(uint256 amount);

    constructor(Config memory c) {
        require(address(c.asset).code.length > 0 && address(c.index).code.length > 0, "not contract");
        require(c.k > 0 && c.epoch > 0 && c.delay >= 1 && c.maxTipAge > 0 && c.maxTipAge <= 2 hours, "params");
        require(c.treasury != address(0) && c.feeBps <= 100 && c.bufferBps <= 10_000, "fees");
        require(c.maxPrincipal > 0, "cap");
        (bool ok, bytes memory ret) = address(c.index).staticcall(abi.encodeWithSignature("frozen()"));
        INDEX_CAN_FREEZE = ok && ret.length == 32;
        (ok, ret) = address(c.index).staticcall(abi.encodeWithSignature("relay()"));
        RELAY_TIP = ok && ret.length == 32;
        asset = c.asset; index = c.index; K = c.k; EPOCH = c.epoch; DELAY = c.delay; MAX_TIP_AGE = c.maxTipAge;
        treasury = c.treasury; FEE_BPS = c.feeBps; BOUNTY_DIVISOR = c.bountyDivisor; BUFFER_BPS = c.bufferBps;
        MAX_PRINCIPAL = c.maxPrincipal; CAP_ERA = c.capEra;
    }

    /// @notice Each side's principal cap for entries priced at Bitcoin height `height`.
    function capAt(uint64 height) public view returns (uint256) {
        uint64 era = height / HALVING_INTERVAL;
        if (era <= CAP_ERA) return MAX_PRINCIPAL;
        uint64 halvings = era - CAP_ERA;
        return halvings >= 256 ? 0 : MAX_PRINCIPAL >> halvings;
    }

    // ---------------------------------------------------------------- requests

    /// @notice The height a request made now would be priced at.
    function nextPricingHeight() public view returns (uint64) {
        uint64 h = RELAY_TIP ? index.relay().bestHeight() + DELAY : IZkTip(address(index)).seenHeight() + seenMargin();
        return _roundUp(h);
    }

    /// @notice How far past the index's newest validated header a request is priced, given that header's age.
    /// @dev The header is one the index validated, but its timestamp is a miner's (up to 2 h ahead is valid);
    ///      the table's skew term covers that. A relay's `DELAY`/`MAX_TIP_AGE` bound would not.
    function seenMargin() public view returns (uint64) {
        return marginForAge(IZkTip(address(index)).seenTime());
    }

    /// @notice The Poisson margin for a header stamped `t` (MARGINS; includes 2 h of timestamp skew).
    function marginForAge(uint256 t) public view returns (uint64) {
        uint256 age = block.timestamp > t ? block.timestamp - t : 0;
        uint256 b = (age + 1 hours - 1) / 1 hours;
        require(b <= 24, "index stale");
        return uint64(uint8(MARGINS[2 * b])) << 8 | uint64(uint8(MARGINS[2 * b + 1]));
    }

    function _roundUp(uint64 h) internal view returns (uint64) {
        return ((h + EPOCH - 1) / EPOCH) * EPOCH;
    }

    /// @notice Whether a request made now would be accepted (UI, deploy checks). Same conditions as `_schedule`.
    function acceptingRequests() external view returns (bool) {
        return !frozen && !_indexFrozen() && _historyConsistent() && _tipFresh();
    }

    function _tipFresh() internal view returns (bool) {
        if (!RELAY_TIP) {
            uint256 f = IZkTip(address(index)).seenTime();
            return f <= block.timestamp + 2 hours && block.timestamp <= f + MAX_SEEN_AGE;
        }
        uint256 t = index.relay().timestampOf(index.relay().bestHash());
        return block.timestamp <= t + MAX_TIP_AGE && t <= block.timestamp + 2 hours;
    }

    function _schedule() internal returns (uint64) {
        require(!frozen && !_indexFrozen() && _historyConsistent(), "pool frozen");
        // The index's own freshness bound (3h) is for folding, far too loose for pricing: a relay that lags
        // lets a requester see the pricing block before asking. Use this pool's tighter bound instead.
        require(_tipFresh(), RELAY_TIP ? "relay stale" : "index stale");
        return _enqueue(nextPricingHeight());
    }

    function _enqueue(uint64 e) internal returns (uint64) {
        uint256 n = queue.length;
        if (RELAY_TIP) {
            // The relay's best height can move down (a heavier, shorter branch). Never queue behind the last
            // epoch: a later height is still unmined, and a strictly increasing queue can never price an epoch
            // twice (which would double-count its entries and brick processing).
            if (n > 0 && queue[n - 1] >= e) return queue[n - 1];
            queue.push(e);
            return e;
        }
        // A later request can price earlier (a fresh header with a small margin can land below an old one with
        // a large margin). Keep the pending
        // epochs sorted and unique instead: each is still priced once, in height order. Every pending epoch is
        // above the finalized height and every processed one at or below it, so order with the processed
        // part is kept too. Pending epochs are bounded by the pricing horizon (≈ a day of heights / EPOCH).
        if (n == head || queue[n - 1] < e) {
            queue.push(e);
            return e;
        }
        for (uint256 i = head; i < n; ++i) {
            if (queue[i] == e) return e;
            if (queue[i] > e) {
                queue.push(queue[n - 1]);
                for (uint256 j = n - 1; j > i; --j) queue[j] = queue[j - 1];
                queue[i] = e;
                return e;
            }
        }
        return e; // unreachable: queue[n - 1] >= e
    }

    /// @notice Deposit `amount`; the principal is `amount` minus the entry fee.
    function requestEnter(bool yang, uint128 amount) external nonReentrant returns (uint256 id) {
        _checkAmount(amount);
        return _enter(yang, amount, _schedule());
    }

    function _checkAmount(uint128 amount) internal view {
        require(amount > _entryFee(amount), "zero");
    }

    function _entryFee(uint128 amount) internal view returns (uint128) {
        return uint128((uint256(amount) * FEE_BPS + 9_999) / 10_000);
    }

    function _enter(bool yang, uint128 amount, uint64 e) internal returns (uint256 id) {
        uint128 fee = _entryFee(amount);
        uint128 principal = amount - fee;
        uint256 side = yang ? 1 : 0;
        require(uint256(principalOf[side]) + pendingIn[side] + principal <= capAt(e), "pool full");
        uint256 before = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), amount);
        // Fee-on-transfer and other short-paying tokens would credit principal that never arrived.
        require(asset.balanceOf(address(this)) - before == amount, "short transfer");
        buffer += fee;
        id = nextId++;
        openAccounts++;
        accounts[id] = Account(msg.sender, yang, e, 0, principal);
        epochs[e].enterIn[yang ? 1 : 0] += principal;
        pendingPrincipal += principal;
        pendingIn[side] += principal;
        emit EnterRequested(id, msg.sender, yang, principal, e);
    }

    /// @notice Irrevocable. Exposure continues until the pricing epoch.
    function requestExit(uint256 id) external nonReentrant {
        _checkExit(id);
        _exit(id, _schedule());
    }

    function _checkExit(uint256 id) internal view {
        Account storage a = accounts[id];
        require(a.owner == msg.sender, "not owner");
        require(a.exitEpoch == 0, "exit pending");
        // Until the entry is priced it may still be refunded by a freeze; an exit queued before that would be
        // subtracted from principal that never joined, underflowing and bricking freezePool.
        require(epochs[a.enterEpoch].processed, "entry pending");
    }

    function _exit(uint256 id, uint64 e) internal {
        Account storage a = accounts[id];
        require(e > a.enterEpoch, "same epoch");
        a.exitEpoch = e;
        epochs[e].exitOut[a.yang ? 1 : 0] += a.principal;
        emit ExitRequested(id, e);
    }

    function transfer(uint256 id, address to) external {
        Account storage a = accounts[id];
        require(a.owner == msg.sender, "not owner");
        require(to != address(0), "zero address");
        a.owner = to;
        emit Transfer(id, msg.sender, to);
    }

    // ---------------------------------------------------------------- index history

    function _indexFrozen() internal view returns (bool) {
        return INDEX_CAN_FREEZE && index.frozen();
    }

    /// @dev Same definition as WujiIndex.historyConsistent, from functions every index version has. An index
    /// without a relay has no second view of history to disagree with; its finalized state is final.
    function _historyConsistent() internal view returns (bool) {
        if (!RELAY_TIP) return true;
        bytes32 h = index.lastHash();
        return h == bytes32(0) || index.relay().headerAt(index.lastHeight()) == h;
    }

    /// @notice Record S at a folded height by walking relay headers back from `from`, which is either the
    /// index's last folded height or an already marked height.
    function mark(uint64 height, uint64 from) public returns (int256 s) {
        if (marked[height]) return sAt[height];
        require(_historyConsistent(), "deep Bitcoin reorg");
        int256 value;
        if (from == index.lastHeight()) value = index.S();
        else { require(marked[from], "unknown base"); value = sAt[from]; }
        require(height <= from && from - height <= MAX_WALK, "walk");
        for (uint64 h = from; h > height; h--) {
            bytes32 hash = index.relay().headerAt(h);
            require(hash != bytes32(0), "header unavailable");
            value -= _increment(sha256(abi.encodePacked(hash)));
        }
        sAt[height] = value; marked[height] = true;
        return value;
    }

    /// @notice Record S at `height` from raw 80-byte headers `height+1 .. to`, where `to` is either the index's
    /// last folded height (its `lastHash` anchors the chain) or a height already marked this way. Needs no
    /// relay history, so it works for an index that keeps only its tip (ZkWujiIndex). Headers are bound by
    /// hash linkage alone: supplying a different chain would require a sha256 second preimage.
    function markWithHeaders(uint64 height, uint64 to, bytes calldata headers) public returns (int256 value) {
        if (marked[height]) return sAt[height];
        uint256 n = headers.length / 80;
        require(headers.length == n * 80 && n > 0 && n <= MAX_WALK && to == height + n, "headers");
        bytes32 anchor;
        if (to == index.lastHeight()) { value = index.S(); anchor = index.lastHash(); }
        else { require(marked[to] && hashAt[to] != bytes32(0), "unknown base"); value = sAt[to]; anchor = hashAt[to]; }
        bytes32 expect = anchor;
        for (uint256 i = n; i > 0; i--) {
            bytes calldata raw = headers[(i - 1) * 80:i * 80];
            bytes32 hash = sha256(abi.encodePacked(sha256(raw)));
            require(hash == expect, "linkage");
            value -= _increment(sha256(abi.encodePacked(hash)));
            expect = bytes32(raw[4:36]);
        }
        sAt[height] = value; marked[height] = true; hashAt[height] = expect;
    }

    /// @dev Identical to WujiIndex.increment (tested), kept local so an index that only exposes its tip works.
    function _byteSum(bytes32 h) internal pure returns (uint256 x) {
        x = uint256(h);
        x = (x & 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF)
            + ((x >> 8) & 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF);
        x = (x & 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF)
            + ((x >> 16) & 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF);
        x = (x & 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF)
            + ((x >> 32) & 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF);
        x = (x & 0x0000000000000000FFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF)
            + ((x >> 64) & 0x0000000000000000FFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF);
        x = (x & 0x00000000000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF) + (x >> 128);
    }
    function _increment(bytes32 R) internal pure returns (int256) { return (int256(_byteSum(R)) - 4080) * 1.2e13; }

    // ---------------------------------------------------------------- epoch processing

    /// @notice Process the next queued epoch once its height is folded. Anyone may call.
    function process() public nonReentrant returns (bool) {
        return _process();
    }

    function _process() internal returns (bool) {
        if (head >= queue.length) return false;
        uint64 e = queue[head];
        if (!marked[e]) {
            uint64 last = index.lastHeight();
            if (e > last) return false;
            if (!RELAY_TIP) {
                // No relay history to walk: an epoch below the tip is marked from raw headers first
                // (`markWithHeaders`); one exactly at the tip is read from the index.
                if (e != last) return false;
                sAt[e] = index.S(); marked[e] = true; hashAt[e] = index.lastHash();
                _advance(e, sAt[e]);
                _payBounty(msg.sender);
                return true;
            }
            // After a long keeper absence the epoch can lie more than MAX_WALK below the tip. Walk down one
            // MAX_WALK chunk per call, remembering the lowest point reached, until the epoch is in range.
            uint64 from = bridge >= e && marked[bridge] ? bridge : last;
            if (from - e > MAX_WALK) {
                uint64 mid = from - uint64(MAX_WALK);
                mark(mid, from);
                bridge = mid;
                _payBounty(msg.sender);
                return false;
            }
            mark(e, from);
        }
        _advance(e, sAt[e]);
        _payBounty(msg.sender);
        return true;
    }

    function processMany(uint256 max) external nonReentrant returns (uint256 n) {
        while (n < max && _process()) n++;
    }

    function _advance(uint64 e, int256 s) internal {
        Epoch storage ep = epochs[e];
        if (started) {
            int256 dS = s - lastS;
            uint256 m = principalOf[0] < principalOf[1] ? principalOf[0] : principalOf[1];
            if (m > 0 && dS != 0) {
                // Per unit of principal: the matched part moves by ΔS/K, the idle excess by nothing.
                int256 move = dS * ACC / K;
                // Both sides round down, so rounding can only leave dust in the pool, never owe it.
                acc[1] += _floorDiv(move * int256(m), int256(uint256(principalOf[1])));
                acc[0] += _floorDiv(-move * int256(m), int256(uint256(principalOf[0])));
            }
        }
        started = true; lastS = s;
        principalOf[0] -= ep.exitOut[0]; principalOf[1] -= ep.exitOut[1];
        pendingPrincipal -= uint256(ep.enterIn[0]) + ep.enterIn[1];
        pendingIn[0] -= ep.enterIn[0]; pendingIn[1] -= ep.enterIn[1];
        if (!ep.frozenRefund) { principalOf[0] += ep.enterIn[0]; principalOf[1] += ep.enterIn[1]; }
        ep.acc = acc; ep.processed = true;
        head++;
        emit EpochProcessed(e, s, acc[0], acc[1]);
    }

    // ---------------------------------------------------------------- values and claims

    function _floorDiv(int256 a, int256 b) internal pure returns (int256 q) {
        q = a / b;
        if (a % b != 0 && (a < 0) != (b < 0)) q -= 1;
    }

    function _raw(uint128 principal, int256 d) internal pure returns (int256) {
        return int256(uint256(principal)) + _floorDiv(int256(uint256(principal)) * d, ACC);
    }

    function _value(uint128 principal, int256 d) internal pure returns (uint256) {
        int256 v = _raw(principal, d);
        if (v <= 0) return 0;
        int256 cap = 2 * int256(uint256(principal));
        return uint256(v > cap ? cap : v);
    }

    function _entryAcc(Account storage a) internal view returns (int256) {
        Epoch storage ep = epochs[a.enterEpoch];
        require(ep.processed, "entry pending");
        return ep.acc[a.yang ? 1 : 0];
    }

    function _endAcc(Account storage a) internal view returns (int256) {
        return a.exitEpoch != 0 && epochs[a.exitEpoch].processed ? epochs[a.exitEpoch].acc[a.yang ? 1 : 0] : acc[a.yang ? 1 : 0];
    }

    /// @dev Loss past the floor is charged to the buffer, then recorded as badDebt. Gain past the ceiling is
    /// deliberately NOT credited anywhere: it is real money only if the matching loser stayed above its floor,
    /// and crediting it early let `sweep` send out money that a floored loser never paid (found by the freeze
    /// invariant suite). It stays in the pool as unaccounted margin, which is what covers such overshoot; once
    /// every account is closed, `sweep` sends the whole remainder to the treasury.
    function _recordBadDebt(Account storage a) internal {
        int256 v = _raw(a.principal, _endAcc(a) - _entryAcc(a));
        if (v >= 0) return;
        uint256 debt = uint256(-v);
        uint256 absorbed = debt < buffer ? debt : buffer;
        buffer -= absorbed; badDebt += debt - absorbed;
        emit BadDebt(debt, absorbed);
    }

    function _payBounty(address to) internal {
        if (BOUNTY_DIVISOR == 0) return;
        uint256 amount = buffer / BOUNTY_DIVISOR;
        if (amount == 0) return;
        buffer -= amount;
        asset.safeTransfer(to, amount);
        emit Bounty(to, amount);
    }

    /// @notice Send buffer above its target to the treasury (FeeRouter → RelayerRewards). Anyone may call.
    function sweep() external nonReentrant returns (uint256 amount) {
        if (openAccounts == 0) {
            // Nobody is owed anything: rounding dust and ceiling surplus leave with the buffer.
            amount = asset.balanceOf(address(this));
            buffer = 0;
            if (amount > 0) { asset.safeTransfer(treasury, amount); emit Swept(amount); }
            return amount;
        }
        uint256 target = (uint256(principalOf[0]) + principalOf[1] + pendingPrincipal) * BUFFER_BPS / 10_000;
        if (buffer <= target) return 0;
        amount = buffer - target;
        buffer = target;
        asset.safeTransfer(treasury, amount);
        emit Swept(amount);
    }

    /// @notice Unclamped value; negative means the account crossed its floor and is not yet retired.
    function rawValueOf(uint256 id) public view returns (int256) {
        Account storage a = accounts[id];
        if (a.owner == address(0) || !epochs[a.enterEpoch].processed || epochs[a.enterEpoch].frozenRefund) return 0;
        return _raw(a.principal, _endAcc(a) - _entryAcc(a));
    }

    /// @notice Value as of the last processed epoch (0 while the entry is pending and not refunded).
    function valueOf(uint256 id) public view returns (uint256) {
        Account storage a = accounts[id];
        if (a.owner == address(0) || !epochs[a.enterEpoch].processed || epochs[a.enterEpoch].frozenRefund) return 0;
        return _value(a.principal, _endAcc(a) - _entryAcc(a));
    }

    /// @notice Pay out a processed exit, a frozen-pool account, or a refunded entry.
    function claim(uint256 id) external nonReentrant {
        Account storage a = accounts[id];
        require(a.owner == msg.sender, "not owner");
        uint256 amount;
        Epoch storage enter = epochs[a.enterEpoch];
        if (enter.processed && enter.frozenRefund) {
            amount = a.principal;
        } else if (a.exitEpoch != 0 && epochs[a.exitEpoch].processed) {
            amount = valueOf(id);
            _recordBadDebt(a);
            uint256 fee = amount * FEE_BPS / 10_000;
            buffer += fee; amount -= fee;
        } else {
            require(frozen && enter.processed, "not claimable");
            amount = valueOf(id);
            _recordBadDebt(a);
            principalOf[a.yang ? 1 : 0] -= a.principal;
        }
        delete accounts[id];
        openAccounts--;
        uint256 balance = asset.balanceOf(address(this));
        if (amount > balance) amount = balance; // only reachable if floor overshoot exhausted everything
        asset.safeTransfer(msg.sender, amount);
        // A winner's value can include a floored loser's unpaid overshoot. Paying it consumes real tokens that
        // the buffer counted as its own: the buffer has then absorbed that overshoot, so it can never claim
        // more than the pool actually holds (else bounties and sweep would revert and brick the pool).
        uint256 left = balance - amount;
        if (buffer > left) { emit BadDebt(buffer - left, buffer - left); buffer = left; }
        emit Claimed(id, msg.sender, amount);
    }

    /// @notice Remove an account that has reached its floor so it stops diluting the matched amount.
    function retire(uint256 id) external nonReentrant {
        Account storage a = accounts[id];
        require(a.owner != address(0) && a.exitEpoch == 0 && !frozen, "not live");
        require(epochs[a.enterEpoch].processed && !epochs[a.enterEpoch].frozenRefund, "entry pending");
        require(valueOf(id) == 0, "not at floor");
        _recordBadDebt(a);
        principalOf[a.yang ? 1 : 0] -= a.principal;
        delete accounts[id];
        openAccounts--;
        emit Retired(id);
        _payBounty(msg.sender);
    }

    // ---------------------------------------------------------------- frozen state

    /// @notice After the index freezes, price every queued epoch: those already folded and markable at their
    /// own S, the rest at the frozen S with their entries refunded. Then the pool stops.
    function freezePool(uint256 max) external nonReentrant {
        require(_indexFrozen(), "index live");
        require(!frozen, "pool frozen");
        int256 s = index.S();
        uint64 last = index.lastHeight();
        uint256 n;
        while (head < queue.length && n < max) {
            uint64 e = queue[head];
            // The relay no longer matches folded history, so unmarked heights cannot be recomputed; once
            // one epoch falls back to the frozen S, every later one does too.
            if (marked[e] && !afterFallback) { _advance(e, sAt[e]); }
            else {
                afterFallback = true;
                // Entries priced after the last folded height never had a price: refund them.
                epochs[e].frozenRefund = e > last;
                _advance(e, s);
            }
            n++;
        }
        if (head < queue.length) return;
        if (started) {
            // Move open accounts to the frozen S.
            uint64 e = type(uint64).max; // sentinel, never queued
            queue.push(e); _advance(e, s);
        }
        frozen = true;
        emit PoolFrozen(s);
    }

    function queueLength() external view returns (uint256) { return queue.length; }
    function epochAcc(uint64 e) external view returns (int256 yin, int256 yang, bool processed) {
        Epoch storage ep = epochs[e]; return (ep.acc[0], ep.acc[1], ep.processed);
    }
    /// @notice Whether an epoch is priced, and whether its entries were refunded by a freeze instead of joining.
    function epochInfo(uint64 e) external view returns (bool processed, bool refunded) {
        Epoch storage ep = epochs[e]; return (ep.processed, ep.frozenRefund);
    }
}
