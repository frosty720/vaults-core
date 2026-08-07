// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import '../VaultManager.sol';

contract VaultManagerV2Mock is VaultManager {
	function version() external pure returns (uint256) { return 2; }
}
