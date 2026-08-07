// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import './MockERC20.sol';

/// @dev WETH9-style WKLC stand-in: deposit() wraps native value 1:1 into ERC20 balance.
contract MockWKLC is MockERC20 {
	constructor() MockERC20('WKLC', 'WKLC', 18) {}

	function deposit() external payable {
		_mint(msg.sender, msg.value);
	}

	receive() external payable {
		_mint(msg.sender, msg.value);
	}
}
