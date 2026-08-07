// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '../interfaces/IV3SwapRouter.sol';

/// @dev Deterministic stand-in for SwapRouter02. Pulls tokenIn from caller,
/// pays tokenOut at a configured rate (tokenOut per 1e18 tokenIn), reverts on slippage.
contract MockSwapRouter is IV3SwapRouter {
	mapping(bytes32 => uint256) public rate; // key(tokenIn,tokenOut) => out per 1e18 in

	function _key(address a, address b) internal pure returns (bytes32) {
		return keccak256(abi.encodePacked(a, b));
	}

	function setRate(address tokenIn, address tokenOut, uint256 outPerIn) external {
		rate[_key(tokenIn, tokenOut)] = outPerIn;
	}

	function exactInputSingle(ExactInputSingleParams calldata p)
		external
		payable
		override
		returns (uint256 amountOut)
	{
		uint256 r = rate[_key(p.tokenIn, p.tokenOut)];
		require(r > 0, 'MockRouter: no rate');
		amountOut = (p.amountIn * r) / 1e18;
		require(amountOut >= p.amountOutMinimum, 'MockRouter: insufficient output');
		IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
		IERC20(p.tokenOut).transfer(p.recipient, amountOut);
	}
}
