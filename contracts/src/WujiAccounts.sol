// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {WujiIndex} from "./WujiIndex.sol";

/// @notice T11 perpetual accounts. Fixed principal, additive P&L = principal·side·ΔS/k, value in
/// [0, 2·principal], no expiry. One collateral and one tier per pool; `WujiAccountsFactory` fixes the menu.
/// See docs/tasks/T11_PERPETUAL_ACCOUNTS.md. No owner, no pause, no upgrade; every parameter is immutable.
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
    /// @notice Requests revert unless the relay's best header is at most this old. Together with DELAY it bounds
    /// the chance that the pricing block already exists when a request lands: at most P(≥ DELAY blocks mined in
    /// MAX_TIP_AGE). 30 min with DELAY 16 gives ≈1e-7 in the worst case (docs/tasks/T11 §Entry and exit timing).
    uint256 public immutable MAX_TIP_AGE;
    /// @notice Whether the index implements the T9 frozen exit. Older indexes (BSC testnet v3) do not; there the
    /// pool simply has no frozen state, and a deep reorg stops new requests and epoch processing instead.
    bool public immutable INDEX_CAN_FREEZE;
    address public immutable treasury;  // FeeRouter: surplus fees go to the relayers' operations reserve
    uint256 public immutable FEE_BPS;   // charged on entry and on normal exit
    uint256 public immutable BOUNTY;    // paid from the buffer per processed epoch and per retirement
    uint256 public immutable BUFFER_BPS; // buffer kept against floor overshoot, relative to live principal

    struct Config {
        IERC20 asset; WujiIndex index; int256 k; uint64 epoch; uint64 delay; uint256 maxTipAge;
        address treasury; uint256 feeBps; uint256 bounty; uint256 bufferBps;
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
    /// @notice Losses beyond the floor that neither the losing account nor the buffer paid. Winners are still
    /// credited those amounts, so this is the pool's only possible shortfall. It stays zero while the buffer
    /// covers overshoot, which is what `retire` and its bounty are for.
    uint256 public badDebt;

    // Index value at arbitrary folded heights, recomputed from relay headers.
    mapping(uint64 => int256) public sAt;
    mapping(uint64 => bool) public marked;
    /// @notice Bitcoin header hash (raw sha256d digest order) at a height marked from supplied headers.
    mapping(uint64 => bytes32) public hashAt;

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
        (bool ok, bytes memory ret) = address(c.index).staticcall(abi.encodeWithSignature("frozen()"));
        INDEX_CAN_FREEZE = ok && ret.length == 32;
        asset = c.asset; index = c.index; K = c.k; EPOCH = c.epoch; DELAY = c.delay; MAX_TIP_AGE = c.maxTipAge;
        treasury = c.treasury; FEE_BPS = c.feeBps; BOUNTY = c.bounty; BUFFER_BPS = c.bufferBps;
    }

    // ---------------------------------------------------------------- requests

    /// @notice The height a request made now would be priced at.
    function nextPricingHeight() public view returns (uint64) {
        uint64 h = index.relay().bestHeight() + DELAY;
        return ((h + EPOCH - 1) / EPOCH) * EPOCH;
    }

    /// @notice Whether a request made now would be accepted (UI, deploy checks). Same conditions as `_schedule`.
    function acceptingRequests() external view returns (bool) {
        return !frozen && !_indexFrozen() && _historyConsistent() && _tipFresh();
    }

    function _tipFresh() internal view returns (bool) {
        uint256 t = index.relay().timestampOf(index.relay().bestHash());
        return block.timestamp <= t + MAX_TIP_AGE && t <= block.timestamp + 2 hours;
    }

    function _schedule() internal returns (uint64 e) {
        require(!frozen && !_indexFrozen() && _historyConsistent(), "pool frozen");
        // The index's own freshness bound (3h) is for folding, far too loose for pricing: a relay that lags
        // lets a requester see the pricing block before asking. Use this pool's tighter bound instead.
        require(_tipFresh(), "relay stale");
        e = nextPricingHeight();
        uint256 n = queue.length;
        if (n == 0 || queue[n - 1] != e) queue.push(e);
    }

    /// @notice Deposit `amount`; the principal is `amount` minus the entry fee.
    function requestEnter(bool yang, uint128 amount) external returns (uint256 id) {
        uint128 fee = uint128((uint256(amount) * FEE_BPS + 9_999) / 10_000);
        require(amount > fee, "zero");
        uint128 principal = amount - fee;
        uint64 e = _schedule();
        asset.safeTransferFrom(msg.sender, address(this), amount);
        buffer += fee;
        id = nextId++;
        accounts[id] = Account(msg.sender, yang, e, 0, principal);
        epochs[e].enterIn[yang ? 1 : 0] += principal;
        emit EnterRequested(id, msg.sender, yang, principal, e);
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

    function _indexFrozen() internal view returns (bool) {
        return INDEX_CAN_FREEZE && index.frozen();
    }

    /// @dev Same definition as WujiIndex.historyConsistent, from functions every index version has.
    function _historyConsistent() internal view returns (bool) {
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
    function process() public returns (bool) {
        if (head >= queue.length) return false;
        uint64 e = queue[head];
        if (!marked[e]) {
            uint64 last = index.lastHeight();
            if (e > last) return false;
            mark(e, last);
        }
        _advance(e, sAt[e]);
        _payBounty(msg.sender);
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
        if (v >= 0) return;
        uint256 debt = uint256(-v);
        uint256 absorbed = debt < buffer ? debt : buffer;
        buffer -= absorbed; badDebt += debt - absorbed;
        emit BadDebt(debt, absorbed);
    }

    function _payBounty(address to) internal {
        uint256 amount = BOUNTY < buffer ? BOUNTY : buffer;
        if (amount == 0) return;
        buffer -= amount;
        asset.safeTransfer(to, amount);
        emit Bounty(to, amount);
    }

    /// @notice Send buffer above its target to the treasury (FeeRouter → RelayerRewards). Anyone may call.
    function sweep() external returns (uint256 amount) {
        uint256 target = (uint256(principalOf[0]) + principalOf[1]) * BUFFER_BPS / 10_000;
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
            uint256 fee = amount * FEE_BPS / 10_000;
            buffer += fee; amount -= fee;
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
        _payBounty(msg.sender);
    }

    // ---------------------------------------------------------------- frozen state

    /// @notice After the index freezes, price every queued epoch: those already folded and markable at their
    /// own S, the rest at the frozen S with their entries refunded. Then the pool stops.
    function freezePool(uint256 max) external {
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
}
