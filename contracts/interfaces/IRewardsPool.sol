// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

interface IRewardsPool {
	function registerVault(uint256 tokenId, uint256 weight, uint256 capUsd) external;
	function claim(uint256 tokenId) external;
	function claimMany(uint256[] calldata tokenIds) external;
	function mature(uint256 tokenId) external;
	function earned(uint256 tokenId) external view returns (uint256);
	function earnedUsdOf(uint256 tokenId) external view returns (uint256);
	function capUsdOf(uint256 tokenId) external view returns (uint256);
	function isMatured(uint256 tokenId) external view returns (bool);
}
