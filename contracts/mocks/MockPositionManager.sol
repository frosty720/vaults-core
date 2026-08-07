// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts/token/ERC721/ERC721.sol';
import '../interfaces/INonfungiblePositionManager.sol';

/// @dev Stand-in for NonfungiblePositionManager. Pulls both tokens from caller,
/// mints a position NFT to `recipient`. Records last mint for assertions.
contract MockPositionManager is INonfungiblePositionManager, ERC721 {
	uint256 public nextId = 1;
	uint256 public lastAmount0;
	uint256 public lastAmount1;
	address public lastRecipient;

	constructor() ERC721('MockV3Pos', 'MV3') {}

	function mint(MintParams calldata p)
		external
		payable
		override
		returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
	{
		IERC20(p.token0).transferFrom(msg.sender, address(this), p.amount0Desired);
		IERC20(p.token1).transferFrom(msg.sender, address(this), p.amount1Desired);
		require(p.amount0Desired >= p.amount0Min && p.amount1Desired >= p.amount1Min, 'MockNPM: slippage');
		tokenId = nextId++;
		_mint(p.recipient, tokenId);
		lastAmount0 = p.amount0Desired;
		lastAmount1 = p.amount1Desired;
		lastRecipient = p.recipient;
		return (tokenId, uint128(p.amount0Desired + p.amount1Desired), p.amount0Desired, p.amount1Desired);
	}
}
