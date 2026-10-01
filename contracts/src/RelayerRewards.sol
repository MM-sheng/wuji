// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Operations reserve: one-off bounties for newly folded heights, never lifetime points.
/// @dev A folder selects at most eight tokens. Unselected/zero-funded work earns no later entitlement.
///      Allocation only touches accounting; token callbacks cannot block unrelated index progress.
contract RelayerRewards is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant BOUNTY_DIVISOR = 10_000;
    uint256 public constant MAX_TOKENS = 8;
    uint256 public constant MAX_HEIGHTS = 256;
    address public immutable index;
    uint64 public immutable GENESIS_HEIGHT;
    uint64 public lastHeight;
    mapping(address => uint256) public reserve;
    mapping(address => uint256) public allocated;
    mapping(address => mapping(address => uint256)) public claimable;
    event Funded(address indexed token, address indexed donor, uint256 amount);
    event Bounty(address indexed token, address indexed worker, uint64 fromHeight, uint64 toHeight, uint256 amount);
    event Claimed(address indexed token, address indexed worker, uint256 amount);

    constructor(address index_, uint64 genesis) {
        require(index_ != address(0) && genesis != 0, "reward parameters");
        index = index_; GENESIS_HEIGHT = genesis; lastHeight = genesis - 1;
    }
    /// @notice Permissionless donation. Funding is available only to future fold calls.
    function fund(address token, uint256 amount) external nonReentrant {
        require(amount != 0, "zero funding");
        uint256 beforeBalance = _sync(token);
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        require(IERC20(token).balanceOf(address(this)) == beforeBalance + amount, "unsupported collateral");
        reserve[token] += amount;
        emit Funded(token, msg.sender, amount);
    }
    /// @notice Recognize direct transfers for future work, never for an already folded height.
    function sync(address token) external nonReentrant { _sync(token); }
    function _sync(address token) internal returns (uint256 balance) {
        balance = IERC20(token).balanceOf(address(this));
        uint256 accounted = reserve[token] + allocated[token];
        require(balance >= accounted, "unsupported balance decrease");
        uint256 received = balance - accounted;
        if (received != 0) { reserve[token] += received; emit Funded(token, address(0), received); }
    }
    /// @notice Index-only accounting. Sorted unique tokens bound work and exclude duplicate bounties.
    /// @dev Empty lists still consume the height range. A later claim cannot choose different tokens.
    function credit(address worker, uint64 from, uint64 to, address[] calldata tokens) external nonReentrant {
        require(msg.sender == index, "index only");
        require(worker != address(0) && from == lastHeight + 1 && to >= from, "height order");
        require(tokens.length <= MAX_TOKENS, "token limit");
        uint256 count = uint256(to) - from + 1;
        require(tokens.length == 0 || count <= MAX_HEIGHTS, "height limit");
        lastHeight = to;
        _allocate(worker, count, tokens, from, to);
    }
    /// @notice Index-only: pay a watcher whose dispute removed a batch (T12) the bounty that batch would have
    ///         earned. Consumes no heights: they stay payable to whoever later folds them for real.
    function award(address worker, uint256 count, address[] calldata tokens) external nonReentrant {
        require(msg.sender == index, "index only");
        require(worker != address(0) && count != 0 && count <= MAX_HEIGHTS, "award count");
        require(tokens.length <= MAX_TOKENS, "token limit");
        _allocate(worker, count, tokens, 0, 0);
    }
    /// @dev `from == to == 0` marks a dispute award in the Bounty event; folded heights are never 0.
    function _allocate(address worker, uint256 count, address[] calldata tokens, uint64 from, uint64 to) internal {
        address previous;
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            require(token > previous, "tokens not sorted unique"); previous = token;
            uint256 amount = _bounty(reserve[token], count);
            if (amount != 0) {
                reserve[token] -= amount; allocated[token] += amount; claimable[token][worker] += amount;
            }
            emit Bounty(token, worker, from, to, amount);
        }
    }
    /// @notice Quote from accounted reserves, excluding unsynchronized direct transfers.
    function quote(address token, uint256 count) external view returns (uint256) {
        require(count <= MAX_HEIGHTS, "height limit");
        return _bounty(reserve[token], count);
    }
    function _bounty(uint256 balance, uint256 count) internal pure returns (uint256 amount) {
        uint256 remaining = balance;
        for (uint256 i; i < count; ++i) remaining -= remaining / BOUNTY_DIVISOR;
        return balance - remaining;
    }
    /// @notice Withdraw a fixed past allocation. Does not sync funds or earn anything from new fees.
    function claim(address token) external nonReentrant returns (uint256 amount) {
        amount = claimable[token][msg.sender];
        if (amount == 0) return 0;
        uint256 beforeBalance = IERC20(token).balanceOf(address(this));
        require(beforeBalance >= reserve[token] + allocated[token], "unsupported balance decrease");
        claimable[token][msg.sender] = 0; allocated[token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        require(IERC20(token).balanceOf(address(this)) == beforeBalance - amount, "unsupported collateral");
        emit Claimed(token, msg.sender, amount);
    }
}
