// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Immutable lifetime work points. Fees belong to points existing when sync is called.
/// @dev Lazy checkpoint accounting avoids iterating tokens or users when work is credited.
contract RelayerRewards is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant SCALE = 1e18;
    address public immutable relay;
    address public immutable index;
    uint256 public sequence;
    uint256 public totalPoints;
    mapping(address => uint256) public points;
    struct Lot { uint256 sequence; uint256 amount; }
    struct Snapshot { uint256 sequence; uint256 acc; }
    struct Token { uint256 accPerPoint; uint256 accountedBalance; Snapshot[] snapshots; }
    struct Account { uint256 cursor; uint256 activePoints; uint256 accPaid; uint256 remainder; }
    mapping(address => Lot[]) private lots;
    mapping(address => Token) private tokens;
    mapping(address => mapping(address => Account)) public accounts;
    event Credited(address indexed worker, uint256 amount, uint256 sequence);
    event Funded(address indexed token, uint256 amount, uint256 accPerPoint);
    event Claimed(address indexed token, address indexed worker, uint256 amount);
    constructor(address relay_, address index_) {
        require(relay_ != address(0) && index_ != address(0) && relay_ != index_, "reward sources");
        relay = relay_; index = index_;
    }
    function credit(address worker, uint256 amount) external {
        require(msg.sender == relay || msg.sender == index, "unauthorized source");
        require(worker != address(0) && amount != 0, "empty credit");
        points[worker] += amount; totalPoints += amount;
        lots[worker].push(Lot(++sequence, amount));
        emit Credited(worker, amount, sequence);
    }
    function accPerPoint(address token) external view returns(uint256) { return tokens[token].accPerPoint; }
    function lotCount(address worker) external view returns(uint256) { return lots[worker].length; }
    /// @notice Donations received before the first points remain pending until someone syncs afterwards.
    function sync(address token) external nonReentrant { _sync(token); }
    function _sync(address token) internal {
        Token storage t = tokens[token];
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance >= t.accountedBalance, "unsupported balance decrease");
        uint256 received = balance - t.accountedBalance;
        if (received == 0 || totalPoints == 0) return;
        t.accPerPoint += Math.mulDiv(received, SCALE, totalPoints);
        t.accountedBalance = balance; // Division dust remains a reserve, never allocated twice.
        uint256 n = t.snapshots.length;
        if (n != 0 && t.snapshots[n-1].sequence == sequence) t.snapshots[n-1].acc = t.accPerPoint;
        else t.snapshots.push(Snapshot(sequence, t.accPerPoint));
        emit Funded(token, received, t.accPerPoint);
    }
    // A credit's sequence is unique. Funding at that sequence occurs AFTER the credit and belongs to it.
    function _before(Token storage t, uint256 seq) internal view returns(uint256) {
        uint256 lo; uint256 hi = t.snapshots.length;
        while (lo < hi) { uint256 mid = (lo + hi) / 2; if (t.snapshots[mid].sequence < seq) lo = mid+1; else hi = mid; }
        return lo == 0 ? 0 : t.snapshots[lo-1].acc;
    }
    function claim(address token) external returns(uint256) { return claim(token, 128); }
    /// @notice Bounded catch-up over the caller's own work lots; call again if cursor < lotCount.
    function claim(address token, uint256 maxLots) public nonReentrant returns(uint256 paid) {
        require(maxLots > 0 && maxLots <= 256, "claim batch");
        _sync(token);
        Token storage t = tokens[token]; Account storage a = accounts[token][msg.sender];
        uint256 acc = t.accPerPoint;
        (paid, a.remainder) = _earned(a.activePoints, acc - a.accPaid, a.remainder);
        uint256 end = Math.min(lots[msg.sender].length, a.cursor + maxLots);
        for (uint256 i = a.cursor; i < end; ++i) {
            Lot storage lot = lots[msg.sender][i]; uint256 earned;
            (earned, a.remainder) = _earned(lot.amount, acc - _before(t, lot.sequence), a.remainder);
            paid += earned; a.activePoints += lot.amount;
        }
        a.cursor = end; a.accPaid = acc;
        if (paid != 0) { t.accountedBalance -= paid; IERC20(token).safeTransfer(msg.sender, paid); }
        emit Claimed(token, msg.sender, paid);
    }
    function _earned(uint256 amount, uint256 delta, uint256 remainder) internal pure returns(uint256 whole, uint256 fraction) {
        whole = Math.mulDiv(amount, delta, SCALE);
        fraction = mulmod(amount, delta, SCALE) + remainder;
        whole += fraction / SCALE; fraction %= SCALE;
    }
}
