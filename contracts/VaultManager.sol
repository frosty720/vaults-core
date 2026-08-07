// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import '@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol';
import '@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol';
import '@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol';
import '@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol';
import '@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol';
import '@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol';
import '@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol';
import './interfaces/IRewardsPool.sol';
import './interfaces/IV3SwapRouter.sol';
import './interfaces/INonfungiblePositionManager.sol';
import './PolLib.sol';

interface IWKLC { function deposit() external payable; }

contract VaultManager is
	ERC721Upgradeable,
	AccessControlUpgradeable,
	ReentrancyGuardUpgradeable,
	PausableUpgradeable,
	UUPSUpgradeable
{
	using SafeERC20Upgradeable for IERC20Upgradeable;

	bytes32 public constant OPERATOR_ROLE = keccak256('OPERATOR_ROLE');
	uint256 private constant BPS = 10_000;
	uint16 private constant MAX_FEE_BPS = 2000; // total fees <= 20% → POL floor enforced at 80%

	struct Tier { uint256 priceUSD; uint16 aprBps; uint256 weight; string metadataURI; bool active; }
	struct StableConfig { bool enabled; uint8 decimals; address v3Pool; uint24 v3Fee; }

	IRewardsPool public rewardsPool;
	address public treasury;
	address public wklc;
	IV3SwapRouter public swapRouter;
	INonfungiblePositionManager public positionManager;

	address public devRecipient;
	address public ambassadorRecipient;
	address public buildersRecipient;

	Tier[] public tiers;
	mapping(address => StableConfig) public stables;
	mapping(uint256 => uint8) public tierOf;

	uint256 public totalWeight;
	uint256 public maxTotalWeight;
	uint256 public nextTokenId;

	uint256 public maxWeightCeiling;
	uint16 public maxRefPriceDeviationBps;
	uint16 public maxSlippageBps;
	uint16 public slippageBps;
	mapping(address => uint256) public referencePrice;

	// Weight snapshotted at mint time, keyed by tokenId. Used on transfer so that an admin
	// editing a tier's weight after NFTs exist cannot desync per-holder weight in the RewardsPool.
	// Appended at the end of storage (consumes one former __gap slot) to keep existing layout intact.
	mapping(uint256 => uint256) public vaultWeight;

	// --- Seeded-bootstrap POL deployment (v3) ---
	// Each purchase market-buys a depth-bounded slice (buy pressure), then seeds the rest of
	// the LP from the protocol WKLC reserve (wklc.balanceOf(this)). See
	// docs/superpowers/specs/2026-06-16-pol-seeded-bootstrap-design.md. (Fresh deploy: these
	// slots replace the removed v2 buffer/drip vars; __gap left at [33] for headroom.)
	uint256 public minBuyUsd;     // whole-dollar floor for the market-buy slice (scaled by stable decimals)
	uint16 public buyImpactBps;   // market-buy = pool stable reserve * buyImpactBps / BPS (e.g. 300 = 3%)

	// --- Vault maturity v2 (T6) ---
	// NB: 2 new slots appended here → __gap shrunk from 34 to 32. Do NOT reorder existing vars.
	address public priceAnchorStable;             // stable whose referencePrice anchors KLC/USD
	mapping(uint256 => uint256) public tierCapBps; // ROI cap per tier index, in bps (e.g. 25000 = 250%)

	// --- 80/20 split + 3-level MLM (v4) ---
	// NB: 3 new slots appended → __gap 33 → 30. Do NOT reorder. See
	// docs/superpowers/specs/2026-06-17-vault-8020-mlm-design.md.
	mapping(address => address) public sponsorOf; // sticky upline; set once on first referred buy
	address public daoTreasury;                   // receives the DAO fee bucket + unqualified MLM legs
	// fee split in bps (packs into one slot). POL = BPS - (sum), enforced >= 80% via MAX_FEE_BPS.
	uint16 public n1Bps;  // affiliate level 1
	uint16 public n2Bps;  // affiliate level 2
	uint16 public n3Bps;  // affiliate level 3
	uint16 public devBps; // dev multisig
	uint16 public daoBps; // DAO treasury (builders/performers/marketing/stabilization/security off-chain)

	uint256[30] private __gap;

	event Purchased(address indexed buyer, uint256 indexed tokenId, uint8 tier, address stable, uint256 paid);
	event SponsorSet(address indexed buyer, address indexed sponsor);
	event FeesRouted(
		address indexed buyer, address indexed stable,
		address n1, address n2, address n3,
		uint256 n1Amt, uint256 n2Amt, uint256 n3Amt, uint256 devAmt, uint256 daoAmt
	);
	event FeeSplitUpdated(uint16 n1Bps, uint16 n2Bps, uint16 n3Bps, uint16 devBps, uint16 daoBps);
	event DaoTreasuryUpdated(address indexed daoTreasury);
	event PolDeployed(address indexed stable, uint256 swapped, uint256 wklcOut, uint256 positionId);
	event ReserveFunded(address indexed from, uint256 wklcAmount);
	event BuyParamsUpdated(uint16 buyImpactBps, uint256 minBuyUsd);
	event PolRefundToTreasury(address indexed stable, uint256 amount);
	event TierUpdated(uint8 indexed index, uint256 priceUSD, uint16 aprBps, bool active);
	event StableConfigured(address indexed stable, bool enabled, uint8 decimals, address v3Pool, uint24 v3Fee);
	event FeeRecipientsUpdated(address indexed dev, address indexed ambassador, address indexed builders);
	event TreasuryUpdated(address indexed treasury);
	event OperatorBoundsUpdated(uint256 maxWeightCeiling, uint16 maxRefPriceDeviationBps, uint16 maxSlippageBps);
	event MaxTotalWeightUpdated(uint256 newMax);
	event ReferencePriceUpdated(address indexed stable, uint256 price);
	event SlippageBpsUpdated(uint16 bps);

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() { _disableInitializers(); }

	function initialize(
		address admin,
		address operator,
		address rewardsPool_,
		address treasury_,
		address wklc_,
		address swapRouter_,
		address positionManager_
	) external initializer {
		require(
			admin != address(0) &&
				operator != address(0) &&
				rewardsPool_ != address(0) &&
				treasury_ != address(0) &&
				wklc_ != address(0) &&
				swapRouter_ != address(0) &&
				positionManager_ != address(0),
			'VM: zero address'
		);
		__ERC721_init('KalyChain Vault', 'KVAULT');
		__AccessControl_init();
		__ReentrancyGuard_init();
		__Pausable_init();
		__UUPSUpgradeable_init();
		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(OPERATOR_ROLE, operator);
		rewardsPool = IRewardsPool(rewardsPool_);
		treasury = treasury_;
		wklc = wklc_;
		swapRouter = IV3SwapRouter(swapRouter_);
		positionManager = INonfungiblePositionManager(positionManager_);
		nextTokenId = 1;
	}

	function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

	function initializeV2() external reinitializer(2) {
		buyImpactBps = 300; // market-buy = 3% of pool depth
		minBuyUsd = 100;    // ...but at least a $100 open-market buy
		// Loosen the LP-add slippage backstop to 15%; the market-buy slice is itself
		// depth-bounded so per-swap price impact stays small. Only set if maxSlippageBps
		// allows it — guards against a proxy that had setOperatorBounds with a tight ceiling.
		slippageBps = 1500 <= maxSlippageBps ? 1500 : maxSlippageBps;
	}

	/// @notice v4: 80/20 split + 3-level MLM. Defaults N1 6% / N2 2.5% / N3 1.5% / dev 2% / DAO 8%
	/// (POL 80%). `daoTreasury_` receives the DAO bucket + unqualified affiliate legs.
	function initializeV3(address daoTreasury_) external reinitializer(3) {
		require(daoTreasury_ != address(0), 'VM: zero dao treasury');
		n1Bps = 600; n2Bps = 250; n3Bps = 150; devBps = 200; daoBps = 800;
		daoTreasury = daoTreasury_;
	}

	function tierWeight(uint8 tier) external view returns (uint256) { return tiers[tier].weight; }

	function supportsInterface(bytes4 id)
		public view override(ERC721Upgradeable, AccessControlUpgradeable) returns (bool)
	{
		return super.supportsInterface(id);
	}

	function setTier(uint8 index, uint256 priceUSD, uint16 aprBps, string calldata metadataURI, bool active)
		external onlyRole(DEFAULT_ADMIN_ROLE)
	{
		require(priceUSD > 0 && aprBps > 0, 'VM: zero tier params');
		uint256 weight = priceUSD * aprBps;
		Tier memory t = Tier(priceUSD, aprBps, weight, metadataURI, active);
		if (index < tiers.length) tiers[index] = t;
		else { require(index == tiers.length, 'VM: tier index gap'); tiers.push(t); }
		emit TierUpdated(index, priceUSD, aprBps, active);
	}

	function setStable(address stable, bool enabled, uint8 decimals_, address v3Pool, uint24 v3Fee)
		external onlyRole(DEFAULT_ADMIN_ROLE)
	{
		require(!enabled || v3Pool != address(0), 'VM: enabled needs pool');
		require(decimals_ <= 18, 'VM: decimals too high');
		stables[stable] = StableConfig(enabled, decimals_, v3Pool, v3Fee);
		emit StableConfigured(stable, enabled, decimals_, v3Pool, v3Fee);
	}

	function setFeeRecipients(address dev_, address amb_, address builders_)
		external onlyRole(DEFAULT_ADMIN_ROLE)
	{
		require(dev_ != address(0) && amb_ != address(0) && builders_ != address(0), 'VM: zero recipient');
		devRecipient = dev_;
		ambassadorRecipient = amb_;
		buildersRecipient = builders_;
		emit FeeRecipientsUpdated(dev_, amb_, builders_);
	}

	/// @notice Set the 20% fee split (bps). Total must be <= 2000 so POL stays >= 80% (enforced floor).
	/// devBps goes to devRecipient (multisig); daoBps + unqualified affiliate legs go to daoTreasury.
	function setFeeSplit(uint16 n1Bps_, uint16 n2Bps_, uint16 n3Bps_, uint16 devBps_, uint16 daoBps_)
		external onlyRole(DEFAULT_ADMIN_ROLE)
	{
		require(uint256(n1Bps_) + n2Bps_ + n3Bps_ + devBps_ + daoBps_ <= MAX_FEE_BPS, 'VM: POL floor');
		n1Bps = n1Bps_; n2Bps = n2Bps_; n3Bps = n3Bps_; devBps = devBps_; daoBps = daoBps_;
		emit FeeSplitUpdated(n1Bps_, n2Bps_, n3Bps_, devBps_, daoBps_);
	}

	function setDaoTreasury(address daoTreasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
		require(daoTreasury_ != address(0), 'VM: zero dao treasury');
		daoTreasury = daoTreasury_;
		emit DaoTreasuryUpdated(daoTreasury_);
	}

	function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
		require(treasury_ != address(0), 'VM: zero treasury');
		treasury = treasury_;
		emit TreasuryUpdated(treasury_);
	}

	function setOperatorBounds(uint256 maxWeightCeiling_, uint16 maxRefPriceDeviationBps_, uint16 maxSlippageBps_)
		external onlyRole(DEFAULT_ADMIN_ROLE)
	{
		require(maxRefPriceDeviationBps_ <= BPS && maxSlippageBps_ <= BPS, 'VM: bps too high');
		maxWeightCeiling = maxWeightCeiling_;
		maxRefPriceDeviationBps = maxRefPriceDeviationBps_;
		maxSlippageBps = maxSlippageBps_;
		emit OperatorBoundsUpdated(maxWeightCeiling_, maxRefPriceDeviationBps_, maxSlippageBps_);
	}

	function setMaxTotalWeight(uint256 newMax) external onlyRole(OPERATOR_ROLE) {
		require(newMax <= maxWeightCeiling, 'VM: above ceiling');
		maxTotalWeight = newMax;
		emit MaxTotalWeightUpdated(newMax);
	}

	function setReferencePrice(address stable, uint256 price) external onlyRole(OPERATOR_ROLE) {
		require(price > 0, 'VM: zero price');
		uint256 prev = referencePrice[stable];
		if (prev != 0 && maxRefPriceDeviationBps != 0) {
			uint256 maxUp = prev + (prev * maxRefPriceDeviationBps) / BPS;
			uint256 maxDown = prev - (prev * maxRefPriceDeviationBps) / BPS;
			require(price <= maxUp && price >= maxDown, 'VM: ref price out of band');
		}
		referencePrice[stable] = price;
		emit ReferencePriceUpdated(stable, price);
	}

	function setSlippageBps(uint16 bps) external onlyRole(OPERATOR_ROLE) {
		require(bps <= maxSlippageBps, 'VM: slippage too high');
		slippageBps = bps;
		emit SlippageBpsUpdated(bps);
	}

	/// @notice Set the market-buy sizing: slice = clamp(buyImpactBps% of pool depth, minBuyUsd, polAmount/2).
	function setBuyParams(uint16 buyImpactBps_, uint256 minBuyUsd_) external onlyRole(OPERATOR_ROLE) {
		require(buyImpactBps_ <= BPS, 'VM: bps too high');
		buyImpactBps = buyImpactBps_;
		minBuyUsd = minBuyUsd_;
		emit BuyParamsUpdated(buyImpactBps_, minBuyUsd_);
	}

	/// @notice Fund the protocol KLC reserve by wrapping native KLC to WKLC. The reserve seeds
	/// the non-bought side of each purchase's POL so the full deposit deploys to LP in-tx.
	function fundReserve() external payable {
		require(msg.value > 0, 'VM: zero value');
		IWKLC(wklc).deposit{ value: msg.value }();
		emit ReserveFunded(msg.sender, msg.value);
	}

	/// @notice Protocol WKLC reserve available to seed POL.
	function reserveWklc() external view returns (uint256) {
		return IERC20Upgradeable(wklc).balanceOf(address(this));
	}

	function rescueERC20(address token, address to, uint256 amount)
		external onlyRole(DEFAULT_ADMIN_ROLE)
	{
		require(to != address(0), 'VM: zero to');
		// WKLC is the protocol POL reserve — never rescuable, or a buy could under-seed.
		require(token != wklc, 'VM: wklc is reserve');
		IERC20Upgradeable(token).safeTransfer(to, amount);
	}

	function pause() external onlyRole(OPERATOR_ROLE) { _pause(); }
	function unpause() external onlyRole(OPERATOR_ROLE) { _unpause(); }

	// Organic / no-referral buy: the referral fee leg goes to ambassadorRecipient (the DAO fallback).
	function purchase(uint8 tier, address stable, uint256 deadline)
		external nonReentrant whenNotPaused returns (uint256 tokenId)
	{
		return _purchase(tier, stable, deadline, address(0));
	}

	// Referred buy: the referral fee leg goes to `referrer` when valid, else the fallback.
	function purchase(uint8 tier, address stable, uint256 deadline, address referrer)
		external nonReentrant whenNotPaused returns (uint256 tokenId)
	{
		return _purchase(tier, stable, deadline, referrer);
	}

	function _purchase(uint8 tier, address stable, uint256 deadline, address referrer)
		internal returns (uint256 tokenId)
	{
		require(deadline >= block.timestamp, 'VM: expired');
		Tier memory t = tiers[tier];
		require(t.active, 'VM: tier inactive');
		StableConfig memory s = stables[stable];
		require(s.enabled, 'VM: stable disabled');
		require(s.v3Pool != address(0), 'VM: pool not ready');
		require(totalWeight + t.weight <= maxTotalWeight, 'VM: cap exceeded');

		uint256 amount = t.priceUSD * (10 ** s.decimals);
		IERC20Upgradeable(stable).safeTransferFrom(msg.sender, address(this), amount);

		// 80/20: route the 20% fees (3-level MLM + dev + DAO) and get back the POL amount (>= 80%).
		uint256 polAmount = _routeFees(stable, amount, referrer);
		_deployPol(stable, s, polAmount, deadline);

		// Effects before the _safeMint interaction (CEI): register weight in both this contract and
		// the RewardsPool *before* the ERC721 receiver callback can observe or act on the new token.
		tokenId = nextTokenId++;
		tierOf[tokenId] = tier;
		vaultWeight[tokenId] = t.weight;
		totalWeight += t.weight;
		_registerInPool(tokenId, tier, t.weight, t.priceUSD);
		_safeMint(msg.sender, tokenId);

		emit Purchased(msg.sender, tokenId, tier, stable, amount);
	}

	/// @dev Route the 20% fee bucket and return the POL amount. Commissions are paid in the purchase
	/// stablecoin. The sponsor (upline) is set once on the first referred buy and is immutable after.
	/// Each affiliate level is paid iff it holds a vault (skin-in-the-game); unqualified/empty levels
	/// roll into the DAO bucket. POL = amount - all fees (>= 80%).
	function _routeFees(address stable, uint256 amount, address referrer) private returns (uint256 polAmount) {
		if (sponsorOf[msg.sender] == address(0) && referrer != address(0) && referrer != msg.sender) {
			sponsorOf[msg.sender] = referrer;
			emit SponsorSet(msg.sender, referrer);
		}
		address n1 = sponsorOf[msg.sender];
		address n2 = n1 != address(0) ? sponsorOf[n1] : address(0);
		address n3 = n2 != address(0) ? sponsorOf[n2] : address(0);

		uint256 a1 = (amount * n1Bps) / BPS;
		uint256 a2 = (amount * n2Bps) / BPS;
		uint256 a3 = (amount * n3Bps) / BPS;
		uint256 devAmt = (amount * devBps) / BPS;
		uint256 daoBase = (amount * daoBps) / BPS;

		// pay each MLM leg if its recipient qualifies, else its amount rolls into the DAO bucket
		uint256 toDao = daoBase + _payLeg(stable, n1, a1) + _payLeg(stable, n2, a2) + _payLeg(stable, n3, a3);
		IERC20Upgradeable(stable).safeTransfer(devRecipient, devAmt);
		IERC20Upgradeable(stable).safeTransfer(daoTreasury, toDao);

		polAmount = amount - a1 - a2 - a3 - devAmt - daoBase; // == amount * polBps / BPS (POL >= 80%)
		emit FeesRouted(msg.sender, stable, n1, n2, n3, a1, a2, a3, devAmt, toDao);
	}

	/// @dev Pay `amt` of `stable` to `who` iff it holds >= 1 vault (skin-in-the-game); otherwise return
	/// `amt` so the caller rolls it into the DAO bucket. Returns 0 when the leg was paid.
	function _payLeg(address stable, address who, uint256 amt) private returns (uint256) {
		if (who != address(0) && amt > 0 && balanceOf(who) > 0) {
			IERC20Upgradeable(stable).safeTransfer(who, amt);
			return 0;
		}
		return amt;
	}

	function tokenURI(uint256 tokenId) public view override returns (string memory) {
		_requireMinted(tokenId);
		return tiers[tierOf[tokenId]].metadataURI;
	}

	function _beforeTokenTransfer(address from, address to, uint256 tokenId, uint256 batchSize)
		internal override
	{
		super._beforeTokenTransfer(from, to, tokenId, batchSize);
		// v2: per-vault state travels with the NFT; no reward bookkeeping needed on transfer.
		// onWeightChange(from, to, ...) removed — replaced by per-tokenId registerVault at mint.
	}

	/// @notice Admin setter for the rewards pool address (needed for post-deploy wiring).
	function setRewardsPool(address rewardsPool_) external onlyRole(DEFAULT_ADMIN_ROLE) {
		require(rewardsPool_ != address(0), 'VM: zero rewards pool');
		rewardsPool = IRewardsPool(rewardsPool_);
	}

	/// @dev Register tokenId in the RewardsPool with its weight and USD cap.
	/// Extracted from _purchase to avoid a stack-too-deep error (the optimizer cannot
	/// keep all _purchase locals + the capUsd expression in registers simultaneously).
	/// capUsd = tierCapBps[tier] * priceUSD * 1e18 / BPS
	/// e.g. tierCapBps=25000 (250% ROI cap), priceUSD=100 → capUsd = 25000*100*1e18/10000 = 250e18 ($250).
	function _registerInPool(uint256 tokenId, uint8 tier, uint256 weight, uint256 priceUSD) internal {
		uint256 capUsd = (tierCapBps[tier] * priceUSD * 1e18) / BPS;
		// A zero cap would mature the vault on its first checkpoint with zero rewards —
		// i.e. the buyer pays full price for a dead vault. Refuse to sell a tier whose
		// ROI cap has not been configured. Every sellable tier MUST have setTierCap called first.
		require(capUsd > 0, 'VM: tier cap unset');
		rewardsPool.registerVault(tokenId, weight, capUsd);
	}

	/// @notice Set the stable token whose referencePrice anchors the KLC/USD price feed.
	/// The stable must already be enabled via setStable().
	function setPriceAnchor(address stable) external onlyRole(OPERATOR_ROLE) {
		require(stables[stable].enabled, 'VM: stable not enabled');
		priceAnchorStable = stable;
	}

	/// @notice Set the ROI cap (in bps) for a given tier index.
	/// e.g. 25000 = 250% ROI cap.
	function setTierCap(uint8 index, uint256 capBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
		require(index < tiers.length, 'VM: bad tier');
		require(capBps <= 1_000_000, 'VM: cap too high');
		tierCapBps[index] = capBps;
	}

	/// @notice USD per KLC, 1e18.
	/// referencePrice[anchor] = KLC per $1 (1e18); USD/KLC = 1e36 / referencePrice.
	function klcUsdPrice() external view returns (uint256) {
		uint256 ref = referencePrice[priceAnchorStable];
		require(ref > 0, 'VM: no anchor price');
		return (10 ** 36) / ref;
	}

	/// @dev Deploy a purchase's POL via PolLib (DELEGATECALL — runs in this contract's context).
	/// market-buy a depth-bounded slice (buy pressure) + seed the rest from the WKLC reserve;
	/// self-terminating as pools deepen. PolLib does the swap/mint/sweep; we emit the events.
	function _deployPol(address stable, StableConfig memory s, uint256 polAmount, uint256 deadline) internal {
		(uint256 a, uint256 wklcOut, uint256 positionId, uint256 leftover) = PolLib.deployPol(PolLib.P({
			stable: stable,
			dec: s.decimals,
			pool: s.v3Pool,
			fee: s.v3Fee,
			polAmount: polAmount,
			deadline: deadline,
			ref: referencePrice[stable],
			buyImpactBps: buyImpactBps,
			minBuyUsd: minBuyUsd,
			slippageBps: slippageBps,
			wklc: wklc,
			router: address(swapRouter),
			npm: address(positionManager),
			treasury: treasury
		}));
		if (leftover > 0) emit PolRefundToTreasury(stable, leftover);
		emit PolDeployed(stable, a, wklcOut, positionId);
	}
}
