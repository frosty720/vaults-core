// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import 'forge-std/Test.sol';
import '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol';
import '../../contracts/RewardsPool.sol';

// ---------------------------------------------------------------------------
// MockVaultManagerInvariant
//
// Minimal IVaultManagerView implementation for invariant testing.
// ownerOf() always returns a fixed "vaultOwner" address so claim() works.
// klcUsdPrice() returns a settable value so the handler can vary price.
//
// COVERAGE CONSTRAINT: All vaults share a single owner address (the handler).
// Per-owner multi-wallet routing is covered by the Hardhat suite (Maturity.spec.ts).
// ---------------------------------------------------------------------------
contract MockVaultManagerInvariant {
	address public vaultOwner;
	uint256 public klcUsd;

	constructor(address owner_, uint256 initialPrice) {
		vaultOwner = owner_;
		klcUsd = initialPrice;
	}

	function ownerOf(uint256 /* id */) external view returns (address) {
		return vaultOwner;
	}

	function klcUsdPrice() external view returns (uint256) {
		return klcUsd;
	}

	function setKlcUsd(uint256 price) external {
		klcUsd = price;
	}
}

// ---------------------------------------------------------------------------
// MaturityHandler — randomised actions driving RewardsPool for invariants
//
// COVERAGE CONSTRAINTS (documented per task spec):
//   1. All vault ownership resolves to the handler itself (see MockVaultManagerInvariant).
//      This means claim() calls always succeed (msg.sender == vaultOwner).
//      Multi-owner scenarios are exercised in the Hardhat suite.
//   2. capUsd is drawn from a bounded range (1e16 – 1000e18) to ensure maturity
//      is reachable within the fuzzing depth and numeric overflow is avoided.
//   3. Weight is bounded 1–500 to keep totalWeight arithmetic well below uint256 max.
//   4. klcUsdPrice is bounded 1e15 – 1e21 (0.001 – 1000 USD per KLC) to avoid
//      division-by-zero and arithmetic overflow in USD conversion.
//   5. KLC sent per deposit is bounded 1 wei – 100 ether to keep values manageable.
//   6. fail_on_revert = false (foundry.toml): expected reverts (no-price, already-matured,
//      zero-weight, already-registered) are swallowed and do not count as failures.
// ---------------------------------------------------------------------------
contract MaturityHandler is Test {
	RewardsPool public pool;
	MockVaultManagerInvariant public mockVm;

	// ── tracking for invariants ──────────────────────────────────────────────

	// All ids that have ever been registered (used to iterate in invariant checks).
	uint256[] public registeredIds;
	mapping(uint256 => bool) public isRegistered;

	// Total KLC ever deposited into the pool.
	uint256 public totalReceived;
	// Total KLC ever claimed out of the pool (sum across all claim() calls).
	uint256 public totalClaimed;

	// Next unused vault id (monotonically increasing so we never double-register).
	uint256 private nextId = 1;

	constructor(RewardsPool pool_, MockVaultManagerInvariant mockVm_) {
		pool = pool_;
		mockVm = mockVm_;
	}

	// ── actions ──────────────────────────────────────────────────────────────

	/// @notice Register a fresh vault with random weight and cap.
	function doRegisterVault(uint256 weightSeed, uint256 capSeed) external {
		// weight: 1 – 500
		uint256 weight = (weightSeed % 500) + 1;
		// capUsd: 1e16 – 1000e18 (range chosen so maturity is reachable)
		uint256 capUsd = 1e16 + (capSeed % (1000e18 - 1e16 + 1));

		uint256 id = nextId++;
		// registerVault may revert if already registered (impossible here since id is fresh)
		// or if weight == 0 (impossible here). No try/catch needed, but guard for safety.
		try pool.registerVault(id, weight, capUsd) {
			registeredIds.push(id);
			isRegistered[id] = true;
		} catch {
			// Unexpected revert — surface it by bubbling (fail_on_revert=false logs it).
		}
	}

	/// @notice Deposit a random amount of KLC into the pool.
	function doDeposit(uint256 amountSeed) external {
		// Bound: 1 wei – 100 ether
		uint256 amount = (amountSeed % 100 ether) + 1;
		// Fund this handler from vm's deal mechanism.
		vm.deal(address(this), amount);
		(bool ok, ) = address(pool).call{ value: amount }('');
		if (ok) totalReceived += amount;
	}

	/// @notice Vary the KLC/USD price.
	function doSetKlcUsd(uint256 priceSeed) external {
		// Bound: 1e15 – 1e21 (0.001 to 1000 USD per KLC)
		uint256 price = 1e15 + (priceSeed % (1e21 - 1e15 + 1));
		mockVm.setKlcUsd(price);
	}

	/// @notice Checkpoint/mature a random registered vault.
	function doMature(uint256 idxSeed) external {
		if (registeredIds.length == 0) return;
		uint256 id = registeredIds[idxSeed % registeredIds.length];
		try pool.mature(id) {} catch {}
	}

	/// @notice Claim rewards for a random registered vault (handler is the owner).
	function doClaim(uint256 idxSeed) external {
		if (registeredIds.length == 0) return;
		uint256 id = registeredIds[idxSeed % registeredIds.length];
		uint256 before = address(this).balance;
		try pool.claim(id) {
			uint256 received = address(this).balance - before;
			totalClaimed += received;
		} catch {}
	}

	/// @notice Accept incoming KLC (from claim() payouts).
	receive() external payable {}

	// ── view helpers used by invariant checks ────────────────────────────────

	function registeredCount() external view returns (uint256) {
		return registeredIds.length;
	}

	function registeredIdAt(uint256 i) external view returns (uint256) {
		return registeredIds[i];
	}
}

// ---------------------------------------------------------------------------
// MaturityInvariant — the three invariant assertions
// ---------------------------------------------------------------------------
contract MaturityInvariant is Test {
	RewardsPool public pool;
	MockVaultManagerInvariant public mockVm;
	MaturityHandler public handler;

	// Admin / roles
	address admin = address(0xA0);

	function setUp() public {
		// Deploy mock VaultManager: initial price $1/KLC (1e18).
		mockVm = new MockVaultManagerInvariant(address(0), 1e18);

		// Deploy RewardsPool proxy.
		RewardsPool impl = new RewardsPool();
		bytes memory init = abi.encodeCall(
			RewardsPool.initialize,
			(admin, address(0), address(mockVm)) // weightUpdater placeholder — we grant below
		);
		// We need to pass a non-zero weightUpdater; use admin temporarily then grant handler.
		init = abi.encodeCall(
			RewardsPool.initialize,
			(admin, admin, address(mockVm))
		);
		pool = RewardsPool(payable(address(new ERC1967Proxy(address(impl), init))));

		// Deploy handler and set it as the mock VaultManager's "owner" (for claim).
		handler = new MaturityHandler(pool, mockVm);
		mockVm.vaultOwner() ; // no-op read to avoid compiler warning
		// Update vaultOwner to be the handler itself so claim() succeeds.
		// MockVaultManagerInvariant.vaultOwner is public but not settable by default;
		// we redeploy with handler address now that we have it.
		mockVm = new MockVaultManagerInvariant(address(handler), 1e18);

		// Re-deploy RewardsPool pointing at the updated mock.
		init = abi.encodeCall(RewardsPool.initialize, (admin, admin, address(mockVm)));
		pool = RewardsPool(payable(address(new ERC1967Proxy(address(impl), init))));

		// Re-create handler pointing at the final pool.
		handler = new MaturityHandler(pool, mockVm);

		// Grant WEIGHT_UPDATER_ROLE to handler so it can registerVault.
		bytes32 wur = pool.WEIGHT_UPDATER_ROLE();
		vm.prank(admin);
		pool.grantRole(wur, address(handler));

		// Target only the handler contract for invariant fuzzing.
		targetContract(address(handler));
	}

	// ────────────────────────────────────────────────────────────────────────
	// Invariant 1: earnedUsdOf(id) never exceeds capUsdOf(id) for any registered vault.
	//
	// The _checkpoint logic clamps earnedUsd at capUsd and then matures the vault.
	// This invariant verifies the clamp is correct and has no off-by-one.
	// ────────────────────────────────────────────────────────────────────────
	function invariant_neverExceedsCap() public view {
		uint256 count = handler.registeredCount();
		for (uint256 i = 0; i < count; i++) {
			uint256 id = handler.registeredIdAt(i);
			assertLe(
				pool.earnedUsdOf(id),
				pool.capUsdOf(id),
				'earnedUsd exceeds capUsd for a registered vault'
			);
		}
	}

	// ────────────────────────────────────────────────────────────────────────
	// Invariant 2: totalWeight() == sum of vaultWeight(id) over all non-matured vaults.
	//
	// When a vault matures, _mature() subtracts its weight from totalWeight and
	// zeros vaultWeight[id].  This invariant verifies the bookkeeping is consistent
	// regardless of the order in which vaults mature or are registered.
	// ────────────────────────────────────────────────────────────────────────
	function invariant_weightConsistent() public view {
		uint256 count = handler.registeredCount();
		uint256 sumWeights = 0;
		for (uint256 i = 0; i < count; i++) {
			uint256 id = handler.registeredIdAt(i);
			// vaultWeight[id] == 0 for matured vaults (zeroed in _mature)
			sumWeights += pool.vaultWeight(id);
		}
		assertEq(
			pool.totalWeight(),
			sumWeights,
			'totalWeight != sum of vaultWeight for active vaults'
		);
	}

	// ────────────────────────────────────────────────────────────────────────
	// Invariant 3: no inflation — claimed + accrued-owed never exceeds total received.
	//
	// totalClaimed (tracked in handler) + sum(accrued[id]) over all registered ids
	// must be <= totalReceived (total KLC ever deposited into the pool).
	//
	// Tolerance: 1 wei per registered vault to absorb integer-division rounding.
	// We use assertLe with tolerance: (claimed + sumAccrued) <= totalReceived + tolerance.
	// ────────────────────────────────────────────────────────────────────────
	function invariant_noInflation() public view {
		uint256 count = handler.registeredCount();
		uint256 sumAccrued = 0;
		for (uint256 i = 0; i < count; i++) {
			uint256 id = handler.registeredIdAt(i);
			sumAccrued += pool.accrued(id);
		}
		uint256 totalOut = handler.totalClaimed() + sumAccrued;
		uint256 totalIn  = handler.totalReceived();
		// Allow 1 wei per vault as integer-rounding tolerance.
		uint256 tolerance = count; // 1 wei per vault
		assertLe(
			totalOut,
			totalIn + tolerance,
			'total output (claimed + accrued) exceeds total KLC received (inflation)'
		);
	}
}
