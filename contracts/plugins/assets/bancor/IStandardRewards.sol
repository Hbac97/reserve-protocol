// SPDX-License-Identifier: BlueOak-1.0.0
pragma solidity 0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IStandardRewards is IERC20{
    function latestProgramId(address pool) external view returns (uint256);

    function claimRewards(uint256 ids) external returns (uint256);
}
