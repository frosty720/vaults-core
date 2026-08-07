// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import '../RewardsPool.sol';

contract RevertingReceiver {
	RewardsPool public pool;
	constructor(RewardsPool _pool) { pool = _pool; }
	// v2: claim() signature changed to claim(tokenId). Stub with tokenId=0 to compile.
	function doClaim() external { pool.claim(0); }
	receive() external payable { revert('no eth'); }
}
