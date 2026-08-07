// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts/token/ERC721/ERC721.sol';
import '../interfaces/INonfungiblePositionManager.sol';

/// @dev Stand-in for NonfungiblePositionManager that mimics REAL behaviour: a full-range mint
/// rarely consumes both desired amounts, so it pulls only a fraction and leaves the remainder
/// in the caller. Used to verify VaultManager sweeps the un-consumed POL dust to the treasury.
contract PartialPositionManager is INonfungiblePositionManager, ERC721 {
	uint256 public nextId = 1;
	// Fraction of each desired amount actually consumed, in basis points (e.g. 6000 = 60%).
	uint256 public consumeBps = 6000;

	constructor() ERC721('PartialV3Pos', 'PV3') {}

	function setConsumeBps(uint256 bps) external {
		consumeBps = bps;
	}

	function mint(MintParams calldata p)
		external
		payable
		override
		returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
	{
		amount0 = (p.amount0Desired * consumeBps) / 10_000;
		amount1 = (p.amount1Desired * consumeBps) / 10_000;
		// Pull only the consumed portion — the rest stays with the caller (VaultManager).
		IERC20(p.token0).transferFrom(msg.sender, address(this), amount0);
		IERC20(p.token1).transferFrom(msg.sender, address(this), amount1);
		tokenId = nextId++;
		_mint(p.recipient, tokenId);
		return (tokenId, uint128(amount0 + amount1), amount0, amount1);
	}
}
