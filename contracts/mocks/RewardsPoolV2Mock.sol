// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import '../RewardsPool.sol';

contract RewardsPoolV2Mock is RewardsPool {
	function version() external pure returns (uint256) {
		return 2;
	}
}
