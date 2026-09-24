// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {WujiIndex} from "./WujiIndex.sol";

/// @notice T11 step 1: perpetual accounts. Fixed principal, additive P&L = principal·side·ΔS/k, value in
/// [0, 2·principal], no expiry. One collateral, one tier. See docs/tasks/T11_PERPETUAL_ACCOUNTS.md.
/// @dev Every entry and exit is priced at an epoch height that was not yet mined when it was requested.
/// Epochs are processed strictly in order; between processed epochs the pool does not move.
contract WujiAccounts {
    using SafeERC20 for IERC20;

    int256 internal constant ONE = 1e18;
    int256 internal constant ACC = 1e27;   // accumulator precision per unit of principal
    uint256 public constant MAX_WALK = 1024;

    IERC20 public immutable asset;
    WujiIndex public immutable index;
    int256 public immutable K;          // wad; annual vol ≈ 115% / K
    uint64 public immutable EPOCH;      // pricing heights are multiples of EPOCH
    uint64 public immutable DELAY;      // pricing height ≥ relay best + DELAY

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
    /// @notice Losses beyond the floor that no account paid: an account that crossed 0 before it was retired
    /// or exited. Winners are still credited those amounts, so this is the pool's only possible shortfall.
    /// Keeping it at zero is what `retire` (and, in step 2, its bounty and the fee buffer) is for.
    uint256 public badDebt;

    // Index value at arbitrary folded heights, recomputed from relay headers.
    mapping(uint64 => int256) public sAt;
    mapping(uint64 => bool) public marked;

    event EnterRequested(uint256 indexed id, address indexed owner, bool yang, uint128 principal, uint64 epoch);
    event ExitRequested(uint256 indexed id, uint64 epoch);
    event EpochProcessed(uint64 indexed epoch, int256 S, int256 accYin, int256 accYang);
    event Claimed(uint256 indexed id, address indexed to, uint256 amount);
    event Retired(uint256 indexed id);
    event Transfer(uint256 indexed id, address indexed from, address indexed to);
    event PoolFrozen(int256 S);

    constructor(IERC20 asset_, WujiIndex index_, int256 k, uint64 epoch, uint64 delay) {
        require(address(asset_).code.length > 0 && address(index_).code.length > 0, "not contract");
        require(k > 0 && epoch > 0 && delay >= 1, "params");
        asset = asset_; index = index_; K = k; EPOCH = epoch; DELAY = delay;
    }

    // ---------------------------------------------------------------- requests

    /// @notice The height a request made now would be priced at.
    function nextPricingHeight() public view returns (uint64) {
        uint64 h = index.relay().bestHeight() + DELAY;
        return ((h + EPOCH - 1) / EPOCH) * EPOCH;
    }

    function _schedule() internal returns (uint64 e) {
        require(!frozen && !index.frozen() && index.historyConsistent(), "pool frozen");
        require(index.relayFresh(), "relay stale");
        e = nextPricingHeight();
        uint256 n = queue.length;
        if (n == 0 || queue[n - 1] != e) queue.push(e);
    }

    function requestEnter(bool yang, uint128 amount) external returns (uint256 id) {
        require(amount > 0, "zero");
        uint64 e = _schedule();
        asset.safeTransferFrom(msg.sender, address(this), amount);
        id = nextId++;
        accounts[id] = Account(msg.sender, yang, e, 0, amount);
        epochs[e].enterIn[yang ? 1 : 0] += amount;
        emit EnterRequested(id, msg.sender, yang, amount, e);
    }

    /// @notice Irrevocable. Exposure continues until the pricing epoch.
    function requestExit(uint256 id) external {
        Account storage a = accounts[id];
        require(a.owner == msg.sender, "not owner");
        require(a.exitEpoch == 0, "exit pending");
        uint64 e = _schedule();
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

    /// @notice Record S at a folded height by walking relay headers back from `from`, which is either the
    /// index's last folded height or an already marked height.
    function mark(uint64 height, uint64 from) public returns (int256 s) {
        if (marked[height]) return sAt[height];
        require(index.historyConsistent(), "deep Bitcoin reorg");
        int256 value;
        if (from == index.lastHeight()) value = index.S();
        else { require(marked[from], "unknown base"); value = sAt[from]; }
        require(height <= from && from - height <= MAX_WALK, "walk");
        for (uint64 h = from; h > height; h--) {
            bytes32 hash = index.relay().headerAt(h);
            require(hash != bytes32(0), "header unavailable");
            value -= index.increment(sha256(abi.encodePacked(hash)));
        }
        sAt[height] = value; marked[height] = true;
        return value;
    }

    // ---------------------------------------------------------------- epoch processing

    /// @notice Process the next queued epoch once its height is folded. Anyone may call.
    function process() public returns (bool) {
        if (head >= queue.length) return false;
        uint64 e = queue[head];
        if (!marked[e]) {
            uint64 last = index.lastHeight();
            if (e > last) return false;
            mark(e, last);
        }
        _advance(e, sAt[e]);
        return true;
    }

    function processMany(uint256 max) external returns (uint256 n) {
        while (n < max && process()) n++;
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

    function _recordBadDebt(Account storage a) internal {
        int256 v = _raw(a.principal, _endAcc(a) - _entryAcc(a));
        if (v < 0) badDebt += uint256(-v);
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
    function claim(uint256 id) external {
        Account storage a = accounts[id];
        require(a.owner == msg.sender, "not owner");
        uint256 amount;
        Epoch storage enter = epochs[a.enterEpoch];
        if (enter.processed && enter.frozenRefund) {
            amount = a.principal;
        } else if (a.exitEpoch != 0 && epochs[a.exitEpoch].processed) {
            amount = valueOf(id);
            _recordBadDebt(a);
        } else {
            require(frozen && enter.processed, "not claimable");
            amount = valueOf(id);
            _recordBadDebt(a);
            principalOf[a.yang ? 1 : 0] -= a.principal;
        }
        delete accounts[id];
        uint256 balance = asset.balanceOf(address(this));
        if (amount > balance) amount = balance; // only reachable if floor overshoot exhausted everything
        asset.safeTransfer(msg.sender, amount);
        emit Claimed(id, msg.sender, amount);
    }

    /// @notice Remove an account that has reached its floor so it stops diluting the matched amount.
    function retire(uint256 id) external {
        Account storage a = accounts[id];
        require(a.owner != address(0) && a.exitEpoch == 0 && !frozen, "not live");
        require(epochs[a.enterEpoch].processed && !epochs[a.enterEpoch].frozenRefund, "entry pending");
        require(valueOf(id) == 0, "not at floor");
        _recordBadDebt(a);
        principalOf[a.yang ? 1 : 0] -= a.principal;
        delete accounts[id];
        emit Retired(id);
    }

    // ---------------------------------------------------------------- frozen state

    /// @notice After the index freezes, price every queued epoch: those already folded and markable at their
    /// own S, the rest at the frozen S with their entries refunded. Then the pool stops.
    function freezePool(uint256 max) external {
        require(index.frozen(), "index live");
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
}
