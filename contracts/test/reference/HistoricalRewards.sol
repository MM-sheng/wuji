// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
/// The frozen T1 relay's original ABI; never deployed. Keeps its differential logic unchanged.
interface HistoricalRewards {
    function relay() external view returns(address);
    function index() external view returns(address);
    function credit(address worker,uint256 amount) external;
}
