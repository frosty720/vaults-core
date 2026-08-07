// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol';

interface IVMPurchase {
	function purchase(uint8 tier, address stable, uint256 deadline) external returns (uint256);
	function totalWeight() external view returns (uint256);
}

interface IPoolV2Weight {
	function totalWeight() external view returns (uint256);
	function vaultWeight(uint256 tokenId) external view returns (uint256);
}

/// @dev Contract buyer that records the system's weight bookkeeping AT THE MOMENT of the
/// _safeMint onERC721Received callback. If VaultManager follows checks-effects-interactions,
/// both the manager's totalWeight and the RewardsPool weight for the minted tokenId must
/// already be registered before the NFT callback fires.
contract WeightProbeReceiver is IERC721Receiver {
	uint256 public seenTotalWeight;
	uint256 public seenPoolWeight;
	bool public callbackFired;
	address public pool;

	function buy(address vm, address pool_, address stable, uint8 tier, uint256 deadline) external {
		pool = pool_;
		IERC20(stable).approve(vm, type(uint256).max);
		IVMPurchase(vm).purchase(tier, stable, deadline);
	}

	function onERC721Received(address, address, uint256 tokenId, bytes calldata) external override returns (bytes4) {
		// msg.sender is the VaultManager (the ERC721 contract minting to us).
		seenTotalWeight = IVMPurchase(msg.sender).totalWeight();
		// v2: per-vault weight is tracked by tokenId in the RewardsPool.
		seenPoolWeight = IPoolV2Weight(pool).vaultWeight(tokenId);
		callbackFired = true;
		return this.onERC721Received.selector;
	}
}
