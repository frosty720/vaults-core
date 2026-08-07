// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import 'forge-std/Test.sol';
import '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol';
import '@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol';
import '../../contracts/VaultManager.sol';
import '../../contracts/RewardsPool.sol';
import '../../contracts/mocks/MockERC20.sol';
import '../../contracts/mocks/MockSwapRouter.sol';
import '../../contracts/mocks/MockPositionManager.sol';

// ---------------------------------------------------------------------------
// SeededPolHandler - drives VaultManager with randomised purchases against a
// thin pool + a generously-funded WKLC reserve (the steady-state production path).
// ---------------------------------------------------------------------------
contract SeededPolHandler is Test, IERC721Receiver {
	VaultManager public vm_;
	MockERC20 public stable;
	address public stableAddr;
	uint8 public constant DEC = 18;
	uint256 public tierPrice; // $1000 in native decimals

	bool public purchaseReverted;
	string public lastRevertReason;

	constructor(VaultManager vm__, MockERC20 stable_) {
		vm_ = vm__;
		stable = stable_;
		stableAddr = address(stable_);
		tierPrice = 1000 * (10 ** DEC);
		stable_.approve(address(vm__), type(uint256).max);
	}

	function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
		return IERC721Receiver.onERC721Received.selector;
	}

	function doPurchase(uint256 /* seed */) external {
		if (vm_.totalWeight() + vm_.tierWeight(0) > vm_.maxTotalWeight()) return;
		stable.mint(address(this), tierPrice);
		try vm_.purchase(0, stableAddr, block.timestamp + 300) returns (uint256) {
			// ok
		} catch Error(string memory reason) {
			purchaseReverted = true;
			lastRevertReason = reason;
		} catch {
			purchaseReverted = true;
			lastRevertReason = 'low-level revert';
		}
	}
}

contract SeededPolInvariant is Test {
	VaultManager public vm_;
	RewardsPool public pool;
	MockERC20 public stable;
	MockSwapRouter public router;
	MockPositionManager public npm;
	MockERC20 public wklc;
	SeededPolHandler public handler;

	address admin = address(0xA0);
	address operator = address(0xA1);
	address treasury = address(0xA2);
	address dev = address(0xA3);
	address amb = address(0xA4);
	address builders = address(0xA5);
	address v3Pool;

	uint8 constant DEC = 18;
	uint256 public initialReserve;

	function setUp() public {
		wklc = new MockERC20('WKLC', 'WKLC', 18);
		stable = new MockERC20('DAI', 'DAI', DEC);
		router = new MockSwapRouter();
		npm = new MockPositionManager();

		wklc.mint(address(router), 1e30);
		router.setRate(address(stable), address(wklc), 500 * 1e18); // 1 DAI = 500 WKLC

		// Thin pool: $2000 DAI depth - market-buy floors to $100 - reserve is drawn each buy.
		v3Pool = address(0xF001);
		stable.mint(v3Pool, 2_000 * (10 ** DEC));

		RewardsPool poolImpl = new RewardsPool();
		bytes memory poolInit = abi.encodeCall(RewardsPool.initialize, (admin, admin, admin));
		pool = RewardsPool(payable(address(new ERC1967Proxy(address(poolImpl), poolInit))));

		VaultManager vmImpl = new VaultManager();
		bytes memory vmInit = abi.encodeCall(VaultManager.initialize, (
			admin, operator, address(pool), treasury, address(wklc), address(router), address(npm)
		));
		vm_ = VaultManager(address(new ERC1967Proxy(address(vmImpl), vmInit)));

		bytes32 weightUpdaterRole = pool.WEIGHT_UPDATER_ROLE();
		vm.prank(admin);
		pool.grantRole(weightUpdaterRole, address(vm_));

		vm.prank(admin);
		vm_.setOperatorBounds(1e36, 1000, 2000);
		vm.prank(admin);
		vm_.initializeV2();
		vm.prank(admin);
		vm_.initializeV3(treasury); // 80/20 + MLM defaults; daoTreasury = treasury

		vm.prank(admin);
		vm_.setTier(0, 1000, 2000, 'ipfs://validator', true);
		vm.prank(admin);
		vm_.setTierCap(0, 35000);
		vm.prank(admin);
		vm_.setFeeRecipients(dev, amb, builders);
		vm.prank(admin);
		vm_.setStable(address(stable), true, DEC, v3Pool, 3000);
		vm.prank(operator);
		vm_.setMaxTotalWeight(1e36);
		vm.prank(operator);
		vm_.setReferencePrice(address(stable), 500 * 1e18);

		// Fund the WKLC reserve generously so the full-seed path is exercised every buy.
		initialReserve = 1e30;
		wklc.mint(address(vm_), initialReserve);

		handler = new SeededPolHandler(vm_, stable);
		targetContract(address(handler));
	}

	/// A purchase against a thin pool with a funded reserve must never revert.
	function invariant_purchaseNeverReverts() public view {
		assertFalse(
			handler.purchaseReverted(),
			string(abi.encodePacked('Unexpected purchase revert: ', handler.lastRevertReason()))
		);
	}

	/// No POL is ever stranded as stable in the manager - every purchase deploys fully (no buffer).
	function invariant_noStableStranded() public view {
		assertEq(stable.balanceOf(address(vm_)), 0, 'stable stranded in VaultManager (should be 0 - no buffer)');
	}

	/// The reserve is only ever drawn (each buy nets it down by `d`); at rest it never exceeds
	/// what was funded. Proves seed draws never conjure WKLC.
	function invariant_reserveNeverExceedsFunded() public view {
		assertLe(wklc.balanceOf(address(vm_)), initialReserve, 'reserve grew beyond funded amount');
	}
}
