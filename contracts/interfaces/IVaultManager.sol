// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

interface IVaultManager {
	function totalWeight() external view returns (uint256);
	function tierWeight(uint8 tier) external view returns (uint256);
}
