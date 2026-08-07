// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import '@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol';
import '@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol';
import './interfaces/IV3SwapRouter.sol';
import './interfaces/INonfungiblePositionManager.sol';

/// @title PolLib — seeded-bootstrap POL deployment, extracted from VaultManager.
/// @dev Called by VaultManager via DELEGATECALL, so it runs in the VaultManager's context
/// (`address(this)` is the VaultManager; its token balances and approvals apply). The library is
/// stateless: every input is passed in `P`, it only makes external calls, and it returns the
/// results for the caller to emit as events. Extracting this keeps VaultManager under the 24KB
/// EIP-170 limit with headroom. See docs/superpowers/specs/2026-06-16-pol-seeded-bootstrap-design.md.
library PolLib {
	using SafeERC20Upgradeable for IERC20Upgradeable;

	uint256 private constant BPS = 10_000;
	int24 private constant MIN_TICK = -887272;
	int24 private constant MAX_TICK = 887272;

	struct P {
		address stable;
		uint8 dec;
		address pool;        // the stable's V3 pool (depth source for the market-buy)
		uint24 fee;
		uint256 polAmount;   // POL to deploy (80% of the purchase)
		uint256 deadline;
		uint256 ref;         // referencePrice[stable]: WKLC(1e18) per 1.0 whole stable
		uint16 buyImpactBps;
		uint256 minBuyUsd;
		uint16 slippageBps;
		address wklc;
		address router;      // V3 SwapRouter02
		address npm;         // NonfungiblePositionManager
		address treasury;
	}

	/// @notice Market-buy a depth-bounded slice (buy pressure), seed the rest of the LP from the
	/// protocol WKLC reserve, mint a full-range position to the treasury, and sweep stable dust.
	/// @return a market-buy amount, wklcOut from that swap, positionId minted, leftover stable swept.
	function deployPol(P memory p) external returns (uint256 a, uint256 wklcOut, uint256 positionId, uint256 leftover) {
		require(p.ref > 0, 'VM: no ref price');
		a = _marketBuy(p.polAmount, IERC20Upgradeable(p.stable).balanceOf(p.pool), p.dec, p.buyImpactBps, p.minBuyUsd);

		// reserve available BEFORE the market-buy adds wklcOut to our balance
		uint256 reserve = IERC20Upgradeable(p.wklc).balanceOf(address(this));

		// market-buy leg (slippage-guarded against referencePrice, normalized to 18-dec)
		{
			uint256 minOut = (a * (10 ** (18 - p.dec)) * p.ref / 1e18 * (BPS - p.slippageBps)) / BPS;
			wklcOut = _swap(p.router, p.stable, p.wklc, p.fee, a, minOut);
		}

		// seed leg: draw reserve WKLC to balance the remaining (polAmount - a) stable.
		// wantWklc = WKLC value of (polAmount - 2a); capped at the reserve (degraded mode if short).
		uint256 lpWklc;
		{
			uint256 wantWklc = (p.polAmount - 2 * a) * p.ref / (10 ** p.dec);
			lpWklc = wklcOut + (wantWklc <= reserve ? wantWklc : reserve);
		}

		positionId = p.stable < p.wklc
			? _mint(p.npm, p.stable, p.wklc, p.fee, p.polAmount - a, lpWklc, p.slippageBps, p.treasury, p.deadline)
			: _mint(p.npm, p.wklc, p.stable, p.fee, lpWklc, p.polAmount - a, p.slippageBps, p.treasury, p.deadline);

		// Refunded stable (ratio mismatch or degraded shortfall) -> treasury as POL value.
		// Refunded WKLC stays in this contract as the reserve — never swept.
		leftover = IERC20Upgradeable(p.stable).balanceOf(address(this));
		if (leftover > 0) IERC20Upgradeable(p.stable).safeTransfer(p.treasury, leftover);
	}

	/// @dev Market-buy slice: clamp(buyImpactBps% of pool depth, minBuyUsd, polAmount/2).
	function _marketBuy(uint256 polAmount, uint256 reserve, uint8 dec, uint16 buyImpactBps, uint256 minBuyUsd)
		private pure returns (uint256 a)
	{
		a = reserve * buyImpactBps / BPS;
		uint256 floorA = minBuyUsd * (10 ** dec);
		if (a < floorA) a = floorA;
		uint256 cap = polAmount / 2;
		if (a > cap) a = cap;
	}

	function _swap(address router, address stable, address wklc, uint24 fee, uint256 swapIn, uint256 minOut)
		private returns (uint256 wklcOut)
	{
		IERC20Upgradeable(stable).forceApprove(router, swapIn);
		wklcOut = IV3SwapRouter(router).exactInputSingle(
			IV3SwapRouter.ExactInputSingleParams({
				tokenIn: stable,
				tokenOut: wklc,
				fee: fee,
				recipient: address(this),
				amountIn: swapIn,
				amountOutMinimum: minOut,
				sqrtPriceLimitX96: 0
			})
		);
	}

	function _mint(
		address npm, address token0, address token1, uint24 fee,
		uint256 amt0, uint256 amt1, uint16 slippageBps, address treasury, uint256 deadline
	) private returns (uint256 positionId) {
		IERC20Upgradeable(token0).forceApprove(npm, amt0);
		IERC20Upgradeable(token1).forceApprove(npm, amt1);
		int24 spacing = _tickSpacing(fee);
		(positionId, , , ) = INonfungiblePositionManager(npm).mint(
			INonfungiblePositionManager.MintParams({
				token0: token0,
				token1: token1,
				fee: fee,
				tickLower: (MIN_TICK / spacing) * spacing,
				tickUpper: (MAX_TICK / spacing) * spacing,
				amount0Desired: amt0,
				amount1Desired: amt1,
				amount0Min: (amt0 * (BPS - slippageBps)) / BPS,
				amount1Min: (amt1 * (BPS - slippageBps)) / BPS,
				recipient: treasury,
				deadline: deadline
			})
		);
	}

	function _tickSpacing(uint24 fee) private pure returns (int24) {
		if (fee == 10000) return 200;
		if (fee == 3000) return 60;
		if (fee == 500) return 10;
		if (fee == 100) return 1;
		revert('VM: unknown fee tier');
	}
}
