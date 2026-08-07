// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

contract MockVaultManagerForRewards {
	mapping(uint256 => address) public owners;
	uint256 public klcUsd;
	function setOwner(uint256 id, address o) external { owners[id] = o; }
	function setKlcUsd(uint256 p) external { klcUsd = p; }
	function ownerOf(uint256 id) external view returns (address) { return owners[id]; }
	function klcUsdPrice() external view returns (uint256) { return klcUsd; }
}
