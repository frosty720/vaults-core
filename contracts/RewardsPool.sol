// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import '@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol';
import '@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol';
import '@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol';
import './interfaces/IRewardsPool.sol';

interface IVaultManagerView {
	function ownerOf(uint256 tokenId) external view returns (address);
	function klcUsdPrice() external view returns (uint256); // USD per KLC, 1e18
}

contract RewardsPool is
	IRewardsPool,
	AccessControlUpgradeable,
	ReentrancyGuardUpgradeable,
	UUPSUpgradeable
{
	bytes32 public constant WEIGHT_UPDATER_ROLE = keccak256('WEIGHT_UPDATER_ROLE');
	bytes32 public constant PAUSER_ROLE = keccak256('PAUSER_ROLE'); // two-tier: can only freeze claims, never move funds
	uint256 private constant PRECISION = 1e18;

	uint256 public totalWeight;
	uint256 public rewardPerWeightStored;
	uint256 public lastDistributedBalance;

	mapping(uint256 => uint256) public vaultWeight;
	mapping(uint256 => uint256) public rewardPerWeightPaid;
	mapping(uint256 => uint256) public accrued;
	mapping(uint256 => uint256) public earnedUsd;
	mapping(uint256 => uint256) public capUsd;
	mapping(uint256 => bool) public matured;

	address public vaultManager;
	bool public claimsPaused; // PAUSER_ROLE circuit breaker for claim()/claimMany() (appended; gap 43 -> 42)
	uint256[42] private __gap;

	event Registered(uint256 indexed tokenId, uint256 weight, uint256 capUsd);
	event Checkpointed(uint256 indexed tokenId, uint256 deltaKlc, uint256 deltaUsd, uint256 totalEarnedUsd);
	event Matured(uint256 indexed tokenId);
	event Claimed(uint256 indexed tokenId, address indexed owner, uint256 amount);
	event Accrued(uint256 received, uint256 rewardPerWeightStored);
	event Revoked(uint256 indexed tokenId, uint256 forfeitedKlc);
	event ClaimsPaused(bool paused);
	event Migrated(uint256 indexed tokenId, uint256 weight, uint256 capUsd, uint256 accruedKlc, uint256 earnedUsd, bool matured);

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() { _disableInitializers(); }

	function initialize(address admin, address weightUpdater, address vaultManager_) external initializer {
		require(admin != address(0) && weightUpdater != address(0) && vaultManager_ != address(0), 'RP: zero address');
		__AccessControl_init();
		__ReentrancyGuard_init();
		__UUPSUpgradeable_init();
		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(WEIGHT_UPDATER_ROLE, weightUpdater);
		vaultManager = vaultManager_;
	}

	receive() external payable {}
	function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

	function _accrue() internal {
		if (totalWeight == 0) return;
		uint256 received = address(this).balance - lastDistributedBalance;
		if (received == 0) return;
		rewardPerWeightStored += (received * PRECISION) / totalWeight;
		lastDistributedBalance += received;
		emit Accrued(received, rewardPerWeightStored);
	}

	function registerVault(uint256 tokenId, uint256 weight, uint256 cap)
		external override nonReentrant onlyRole(WEIGHT_UPDATER_ROLE)
	{
		require(vaultWeight[tokenId] == 0 && !matured[tokenId], 'RP: already registered');
		require(weight > 0, 'RP: zero weight');
		_accrue();
		vaultWeight[tokenId] = weight;
		capUsd[tokenId] = cap;
		rewardPerWeightPaid[tokenId] = rewardPerWeightStored;
		totalWeight += weight;
		emit Registered(tokenId, weight, cap);
	}

	/// @notice Admin revocation (via the VaultManager): the vault stops earning, every KLC it had
	/// coming — pending and already-checkpointed — is forfeited back to the distributable pool,
	/// and the id is marked matured so it can never be registered again.
	function revokeVault(uint256 tokenId)
		external override nonReentrant onlyRole(WEIGHT_UPDATER_ROLE) returns (uint256 forfeitedKlc)
	{
		require(vaultWeight[tokenId] > 0 || matured[tokenId], 'RP: not registered');
		_accrue();
		forfeitedKlc = _pendingKlc(tokenId) + accrued[tokenId];
		rewardPerWeightPaid[tokenId] = rewardPerWeightStored;
		accrued[tokenId] = 0;
		if (!matured[tokenId]) {
			matured[tokenId] = true;
			totalWeight -= vaultWeight[tokenId];
			vaultWeight[tokenId] = 0;
		}
		// forfeited KLC stays in the contract and is picked up by the next _accrue() for the others
		if (forfeitedKlc > 0) lastDistributedBalance -= forfeitedKlc;
		emit Revoked(tokenId, forfeitedKlc);
	}

	/// @notice Relaunch migration (via the VaultManager): restore one snapshot vault's reward state. The
	/// carried `accruedKlc` must already sit in this contract (funded by the migrator) — it is earmarked
	/// (lastDistributedBalance) so it is claimable by that vault only and never redistributed by weight.
	function migrateVault(uint256 tokenId, uint256 weight, uint256 cap, uint256 accruedKlc, uint256 earnedUsd_, bool matured_)
		external override nonReentrant onlyRole(WEIGHT_UPDATER_ROLE)
	{
		require(vaultWeight[tokenId] == 0 && !matured[tokenId] && accrued[tokenId] == 0, 'RP: already registered');
		require(address(this).balance - lastDistributedBalance >= accruedKlc, 'RP: accrued not funded');
		lastDistributedBalance += accruedKlc;
		accrued[tokenId] = accruedKlc;
		capUsd[tokenId] = cap;
		earnedUsd[tokenId] = earnedUsd_;
		rewardPerWeightPaid[tokenId] = rewardPerWeightStored;
		if (matured_) {
			matured[tokenId] = true;
		} else {
			require(weight > 0, 'RP: zero weight');
			vaultWeight[tokenId] = weight;
			totalWeight += weight;
		}
		emit Migrated(tokenId, matured_ ? 0 : weight, cap, accruedKlc, earnedUsd_, matured_);
	}

	/// @notice Circuit breaker (PAUSER_ROLE): freezes claim()/claimMany() only. Checkpoints/maturity keep working.
	function pause() external onlyRole(PAUSER_ROLE) { claimsPaused = true; emit ClaimsPaused(true); }
	function unpause() external onlyRole(PAUSER_ROLE) { claimsPaused = false; emit ClaimsPaused(false); }

	// ─── internal helpers ────────────────────────────────────────────────────

	function _pendingKlc(uint256 id) internal view returns (uint256) {
		if (matured[id] || vaultWeight[id] == 0) return 0;
		return (vaultWeight[id] * (rewardPerWeightStored - rewardPerWeightPaid[id])) / PRECISION;
	}

	function _mature(uint256 id) internal {
		matured[id] = true;
		totalWeight -= vaultWeight[id];
		vaultWeight[id] = 0;
		emit Matured(id);
	}

	function _checkpoint(uint256 id) internal {
		_accrue();
		if (matured[id] || vaultWeight[id] == 0) {
			rewardPerWeightPaid[id] = rewardPerWeightStored;
			return;
		}
		uint256 deltaKlc = _pendingKlc(id);
		rewardPerWeightPaid[id] = rewardPerWeightStored;
		if (deltaKlc == 0) return;

		uint256 klcUsd = IVaultManagerView(vaultManager).klcUsdPrice(); // USD per KLC, 1e18
		require(klcUsd > 0, 'RP: no price');
		uint256 deltaUsd = (deltaKlc * klcUsd) / PRECISION;
		uint256 remainingUsd = capUsd[id] - earnedUsd[id];

		if (deltaUsd < remainingUsd) {
			accrued[id] += deltaKlc;
			earnedUsd[id] += deltaUsd;
			emit Checkpointed(id, deltaKlc, deltaUsd, earnedUsd[id]);
		} else {
			// clamp at cap: pay only the KLC equivalent of the remaining USD, then mature
			uint256 payKlc = (remainingUsd * PRECISION) / klcUsd;
			if (payKlc > deltaKlc) payKlc = deltaKlc;
			accrued[id] += payKlc;
			earnedUsd[id] = capUsd[id];
			// recycle the unpaid excess back to the distributable pool for remaining vaults
			uint256 excess = deltaKlc - payKlc;
			if (excess > 0) lastDistributedBalance -= excess;
			emit Checkpointed(id, payKlc, remainingUsd, capUsd[id]);
			_mature(id);
		}
	}

	// ─── external state-changing functions ──────────────────────────────────

	// ─── claim ──────────────────────────────────────────────────────────────

	/// @dev CEI-compliant internal claim.  State is fully updated before any
	///      external call, so reentrancy via the value-transfer cannot double-pay.
	function _claim(uint256 id) internal returns (uint256) {
		require(IVaultManagerView(vaultManager).ownerOf(id) == msg.sender, 'RP: not owner');
		_checkpoint(id);
		uint256 amount = accrued[id];
		if (amount == 0) return 0;
		// --- effects before interaction (CEI) ---
		accrued[id] = 0;
		lastDistributedBalance -= amount;
		// --- interaction ---
		(bool ok, ) = payable(msg.sender).call{ value: amount }('');
		require(ok, 'RP: transfer failed');
		emit Claimed(id, msg.sender, amount);
		return amount;
	}

	function claim(uint256 id) external override nonReentrant { require(!claimsPaused, 'RP: paused'); _claim(id); }

	function claimMany(uint256[] calldata ids) external override nonReentrant {
		require(!claimsPaused, 'RP: paused');
		for (uint256 i = 0; i < ids.length; i++) { _claim(ids[i]); }
	}

	/// @notice Checkpoint this vault's USD earnings; matures it if the cap is reached.
	/// @dev Intentionally permissionless — anyone may trigger maturity on any vault.
	///      This allows keepers, liquidators, or any third party to finalize a vault's
	///      rewards lifecycle without requiring the owner to act.  Maturity only ever
	///      reduces what the vault can earn (excess is recycled); it does not allow
	///      withdrawal — only the owner can call claim()/claimMany().
	function mature(uint256 id) external override nonReentrant { _checkpoint(id); }

	// ─── views ──────────────────────────────────────────────────────────────

	function earned(uint256 id) external view override returns (uint256) {
		if (matured[id]) return accrued[id];
		uint256 rpw = rewardPerWeightStored;
		if (totalWeight > 0) {
			uint256 received = address(this).balance - lastDistributedBalance;
			if (received > 0) rpw += (received * PRECISION) / totalWeight;
		}
		uint256 deltaKlc = vaultWeight[id] == 0 ? 0 : (vaultWeight[id] * (rpw - rewardPerWeightPaid[id])) / PRECISION;
		uint256 klcUsd = IVaultManagerView(vaultManager).klcUsdPrice();
		if (klcUsd == 0) return accrued[id];
		uint256 remainingUsd = capUsd[id] - earnedUsd[id];
		uint256 deltaUsd = (deltaKlc * klcUsd) / PRECISION;
		if (deltaUsd >= remainingUsd) deltaKlc = (remainingUsd * PRECISION) / klcUsd; // clamp
		return accrued[id] + deltaKlc;
	}

	function earnedUsdOf(uint256 tokenId) external view override returns (uint256) { return earnedUsd[tokenId]; }
	function capUsdOf(uint256 tokenId) external view override returns (uint256) { return capUsd[tokenId]; }
	function isMatured(uint256 tokenId) external view override returns (bool) { return matured[tokenId]; }
}
