import { expect } from 'chai'
import { ethers, upgrades } from 'hardhat'

const FUTURE = 9999999999n

export async function deploySystem() {
	const [admin, operator, treasury, alice, bob, dev, amb, builders, dao] = await ethers.getSigners()
	const ERC20 = await ethers.getContractFactory('MockERC20')
	const wklc = await ERC20.deploy('WKLC', 'WKLC', 18)
	const dai = await ERC20.deploy('DAI', 'DAI', 18)
	const router = await (await ethers.getContractFactory('MockSwapRouter')).deploy()
	const npm = await (await ethers.getContractFactory('MockPositionManager')).deploy()

	const Pool = await ethers.getContractFactory('RewardsPool')
	// v2: initialize(admin, weightUpdater, vaultManager_). Pass admin as placeholder for vaultManager_
	// (vm address not known yet); vm.target is granted WEIGHT_UPDATER_ROLE below.
	const pool = await upgrades.deployProxy(Pool, [admin.address, admin.address, admin.address], { kind: 'uups' })

	const polLib = await (await ethers.getContractFactory('PolLib')).deploy()
	const VM = await ethers.getContractFactory('VaultManager', { libraries: { PolLib: polLib.target } })
	const vm = await upgrades.deployProxy(VM, [
		admin.address, operator.address, pool.target, treasury.address,
		wklc.target, router.target, npm.target,
	], { kind: 'uups', unsafeAllow: ['external-library-linking'] })

	await pool.connect(admin).grantRole(await pool.WEIGHT_UPDATER_ROLE(), vm.target)
	// Set permissive bounds + run initializeV2 (buyImpactBps=300, minBuyUsd=100, slippage backstop)
	// so POL deploys correctly in every fixture. Callers may re-tighten bounds/slippage afterwards.
	await vm.connect(admin).setOperatorBounds(10n ** 30n, 4000, 2000)
	await (vm as any).connect(admin).initializeV2()
	await (vm as any).connect(admin).initializeV3(dao.address) // 80/20 + MLM defaults; daoTreasury = dao
	return { vm, pool, wklc, dai, router, npm, admin, operator, treasury, alice, bob, dev, amb, builders, dao }
}

describe('VaultManager', () => {
	it('initializes roles and immutable wiring', async () => {
		const { vm, pool, treasury, admin, operator } = await deploySystem()
		expect(await vm.hasRole(await vm.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true)
		expect(await vm.hasRole(await vm.OPERATOR_ROLE(), operator.address)).to.equal(true)
		expect(await vm.rewardsPool()).to.equal(pool.target)
		expect(await vm.treasury()).to.equal(treasury.address)
	})

	it('admin adds a tier with derived weight = priceUSD * aprBps', async () => {
		const { vm, admin } = await deploySystem()
		await vm.connect(admin).setTier(0, 100, 1500, 'ipfs://light', true)
		const t = await vm.tiers(0)
		expect(t.weight).to.equal(100n * 1500n)
		expect(await vm.tierWeight(0)).to.equal(150000n)
	})

	it('non-admin cannot set a tier', async () => {
		const { vm, alice } = await deploySystem()
		await expect(vm.connect(alice).setTier(0, 100, 1500, 'ipfs://light', true))
			.to.be.revertedWith(/AccessControl: account .* is missing role/)
	})

	it('admin enables a stable with pool + fee + decimals', async () => {
		const { vm, admin, dai } = await deploySystem()
		const pool = ethers.Wallet.createRandom().address
		await vm.connect(admin).setStable(dai.target, true, 18, pool, 10000)
		const cfg = await vm.stables(dai.target)
		expect(cfg.enabled).to.equal(true)
		expect(cfg.v3Pool).to.equal(pool)
		expect(cfg.v3Fee).to.equal(10000n)
	})

	it('admin sets fee recipients and operator bounds', async () => {
		const { vm, admin, dev, amb, builders } = await deploySystem()
		await vm.connect(admin).setFeeRecipients(dev.address, amb.address, builders.address)
		await vm.connect(admin).setOperatorBounds(1000000000n, 500, 300)
		expect(await vm.devRecipient()).to.equal(dev.address)
		expect(await vm.maxRefPriceDeviationBps()).to.equal(500n)
		expect(await vm.maxSlippageBps()).to.equal(300n)
	})

	it('operator sets maxTotalWeight up to the admin ceiling, reverts above', async () => {
		const { vm, admin, operator } = await deploySystem()
		await vm.connect(admin).setOperatorBounds(1000n, 500, 300)
		await vm.connect(operator).setMaxTotalWeight(800n)
		expect(await vm.maxTotalWeight()).to.equal(800n)
		await expect(vm.connect(operator).setMaxTotalWeight(1001n)).to.be.revertedWith('VM: above ceiling')
	})

	it('operator reference-price update bounded by max deviation', async () => {
		const { vm, admin, operator, dai } = await deploySystem()
		await vm.connect(admin).setOperatorBounds(0, 500, 300) // 5% max deviation
		await vm.connect(operator).setReferencePrice(dai.target, ethers.parseEther('500'))
		await expect(
			vm.connect(operator).setReferencePrice(dai.target, ethers.parseEther('600'))
		).to.be.revertedWith('VM: ref price out of band')
		await vm.connect(operator).setReferencePrice(dai.target, ethers.parseEther('520'))
		expect(await vm.referencePrice(dai.target)).to.equal(ethers.parseEther('520'))
	})

	it('operator sets slippage within bound and can pause', async () => {
		const { vm, admin, operator } = await deploySystem()
		await vm.connect(admin).setOperatorBounds(0, 0, 300)
		await vm.connect(operator).setSlippageBps(250)
		expect(await vm.slippageBps()).to.equal(250n)
		await expect(vm.connect(operator).setSlippageBps(301)).to.be.revertedWith('VM: slippage too high')
		await vm.connect(operator).pause()
		expect(await vm.paused()).to.equal(true)
	})

	it('non-operator cannot call operator setters', async () => {
		const { vm, admin, alice, dai } = await deploySystem()
		await vm.connect(admin).setOperatorBounds(1000n, 500, 300)
		await expect(vm.connect(alice).setMaxTotalWeight(100n))
			.to.be.revertedWith(/AccessControl: account .* is missing role/)
	})

	async function configured() {
		const sys = await deploySystem()
		const { vm, admin, operator, dai, wklc, router, dev, amb, builders } = sys
		await vm.connect(admin).setTier(0, 100, 1500, 'ipfs://light', true)
		await vm.connect(admin).setTierCap(0, 25000)
		await vm.connect(admin).setFeeRecipients(dev.address, amb.address, builders.address)
		await vm.connect(admin).setStable(dai.target, true, 18, ethers.Wallet.createRandom().address, 10000)
		await vm.connect(admin).setOperatorBounds(1000000000000n, 1000, 500)
		await vm.connect(operator).setMaxTotalWeight(1000000000000n)
		await vm.connect(operator).setReferencePrice(dai.target, ethers.parseEther('500'))
		await vm.connect(operator).setSlippageBps(300)
		await router.setRate(dai.target, wklc.target, ethers.parseEther('500'))
		await wklc.mint(router.target, ethers.parseEther('1000000'))
		return sys
	}

	it('purchase routes the 80/20 split (no sponsor → MLM legs roll to the DAO)', async () => {
		const { vm, dai, alice, dev, dao } = await configured()
		const price = ethers.parseEther('100')
		await dai.mint(alice.address, price)
		await dai.connect(alice).approve(vm.target, price)
		await vm.connect(alice).purchase(0, dai.target, FUTURE)
		// no referrer → no sponsor → N1/N2/N3 (10%) roll into the DAO bucket.
		// dev 2% = $2; DAO 8% + 10% rolled = 18% = $18; POL 80% = $80.
		expect(await dai.balanceOf(dev.address)).to.equal(ethers.parseEther('2'))
		expect(await dai.balanceOf(dao.address)).to.equal(ethers.parseEther('18'))
	})

	it('purchase reverts on a disabled stable / when paused', async () => {
		const { vm, admin, operator, dai, alice } = await configured()
		const other = await (await ethers.getContractFactory('MockERC20')).deploy('X', 'X', 18)
		await other.mint(alice.address, ethers.parseEther('100'))
		await other.connect(alice).approve(vm.target, ethers.parseEther('100'))
		await expect(vm.connect(alice).purchase(0, other.target, FUTURE)).to.be.revertedWith('VM: stable disabled')
		await vm.connect(operator).pause()
		await dai.mint(alice.address, ethers.parseEther('100'))
		await dai.connect(alice).approve(vm.target, ethers.parseEther('100'))
		await expect(vm.connect(alice).purchase(0, dai.target, FUTURE)).to.be.revertedWith('Pausable: paused')
	})

	it('POL: swaps 50% of the 91% to WKLC and mints a full-range position to treasury', async () => {
		const { vm, admin, operator, dai, wklc, router, npm, alice, dev, amb, builders, treasury } = await deploySystem()
		await vm.connect(admin).setTier(0, 100, 1500, 'ipfs://light', true)
		await vm.connect(admin).setTierCap(0, 25000)
		await vm.connect(admin).setFeeRecipients(dev.address, amb.address, builders.address)
		await vm.connect(admin).setStable(dai.target, true, 18, ethers.Wallet.createRandom().address, 10000)
		await vm.connect(admin).setOperatorBounds(1000000000000n, 1000, 1000)
		await vm.connect(operator).setMaxTotalWeight(1000000000000n)
		await vm.connect(operator).setReferencePrice(dai.target, ethers.parseEther('500'))
		await vm.connect(operator).setSlippageBps(300)
		await router.setRate(dai.target, wklc.target, ethers.parseEther('500'))
		await wklc.mint(router.target, ethers.parseEther('1000000'))

		const price = ethers.parseEther('100')
		await dai.mint(alice.address, price)
		await dai.connect(alice).approve(vm.target, price)
		await vm.connect(alice).purchase(0, dai.target, FUTURE)

		expect(await npm.lastRecipient()).to.equal(treasury.address)
		expect(await npm.ownerOf(1)).to.equal(treasury.address)
	})

	async function fullBuy() {
		const sys = await deploySystem()
		const { vm, admin, operator, dai, wklc, router, alice, dev, amb, builders } = sys
		await vm.connect(admin).setTier(0, 100, 1500, 'ipfs://light', true)
		await vm.connect(admin).setTierCap(0, 25000)
		await vm.connect(admin).setFeeRecipients(dev.address, amb.address, builders.address)
		await vm.connect(admin).setStable(dai.target, true, 18, ethers.Wallet.createRandom().address, 10000)
		await vm.connect(admin).setOperatorBounds(1000000000000n, 1000, 1000)
		await vm.connect(operator).setMaxTotalWeight(1000000000000n)
		await vm.connect(operator).setReferencePrice(dai.target, ethers.parseEther('500'))
		await vm.connect(operator).setSlippageBps(300)
		await router.setRate(dai.target, wklc.target, ethers.parseEther('500'))
		await wklc.mint(router.target, ethers.parseEther('1000000'))
		await dai.mint(alice.address, ethers.parseEther('100'))
		await dai.connect(alice).approve(vm.target, ethers.parseEther('100'))
		await vm.connect(alice).purchase(0, dai.target, FUTURE)
		return sys
	}

	it('POL: reverts the whole purchase when swap slippage exceeds tolerance', async () => {
		const { vm, admin, operator, dai, wklc, router, alice, dev, amb, builders } = await deploySystem()
		await vm.connect(admin).setTier(0, 100, 1500, 'ipfs://light', true)
		await vm.connect(admin).setTierCap(0, 25000)
		await vm.connect(admin).setFeeRecipients(dev.address, amb.address, builders.address)
		await vm.connect(admin).setStable(dai.target, true, 18, ethers.Wallet.createRandom().address, 10000)
		await vm.connect(admin).setOperatorBounds(1000000000000n, 1000, 1000)
		await vm.connect(operator).setMaxTotalWeight(1000000000000n)
		await vm.connect(operator).setReferencePrice(dai.target, ethers.parseEther('500'))
		await vm.connect(operator).setSlippageBps(100)
		await router.setRate(dai.target, wklc.target, ethers.parseEther('100')) // far worse than ref
		await wklc.mint(router.target, ethers.parseEther('1000000'))
		const price = ethers.parseEther('100')
		await dai.mint(alice.address, price)
		await dai.connect(alice).approve(vm.target, price)
		await expect(vm.connect(alice).purchase(0, dai.target, FUTURE)).to.be.revertedWith('MockRouter: insufficient output')
	})

	it('reverts purchase that would exceed maxTotalWeight', async () => {
		const { vm, admin, operator, dai, wklc, router, alice, dev, amb, builders } = await deploySystem()
		await vm.connect(admin).setTier(0, 100, 1500, 'ipfs://light', true) // weight 150000
		await vm.connect(admin).setTierCap(0, 25000)
		await vm.connect(admin).setFeeRecipients(dev.address, amb.address, builders.address)
		await vm.connect(admin).setStable(dai.target, true, 18, ethers.Wallet.createRandom().address, 10000)
		await vm.connect(admin).setOperatorBounds(1000000000000n, 1000, 1000)
		await vm.connect(operator).setMaxTotalWeight(100000n) // below one tier's weight (150000)
		await vm.connect(operator).setReferencePrice(dai.target, ethers.parseEther('500'))
		await vm.connect(operator).setSlippageBps(300)
		await router.setRate(dai.target, wklc.target, ethers.parseEther('500'))
		await wklc.mint(router.target, ethers.parseEther('1000000'))
		await dai.mint(alice.address, ethers.parseEther('100'))
		await dai.connect(alice).approve(vm.target, ethers.parseEther('100'))
		await expect(vm.connect(alice).purchase(0, dai.target, FUTURE)).to.be.revertedWith('VM: cap exceeded')
	})

	it('tokenURI returns the tier metadata URI', async () => {
		const { vm } = await fullBuy()
		expect(await vm.tokenURI(1)).to.equal('ipfs://light')
	})

	it('transfer does not revert (v2: per-vault state travels with NFT, no pool bookkeeping on transfer)', async () => {
		// v2: superseded by RewardsPoolV2/Maturity tests — per-address earned/weightOf removed.
		const { vm, alice, bob } = await fullBuy()
		// Transfer must succeed; no pool.earned/weightOf assertions (those APIs are gone in v2).
		await vm.connect(alice).transferFrom(alice.address, bob.address, 1)
		expect(await vm.ownerOf(1)).to.equal(bob.address)
	})

	it('reverts purchase with an expired deadline', async () => {
		const { vm, dai, alice } = await configured()
		await dai.mint(alice.address, ethers.parseEther('100'))
		await dai.connect(alice).approve(vm.target, ethers.parseEther('100'))
		await expect(vm.connect(alice).purchase(0, dai.target, 1n)).to.be.revertedWith('VM: expired')
	})

	it('reverts purchase when stable enabled but pool not set (guarded at setStable)', async () => {
		const { vm, admin, dai } = await deploySystem()
		await expect(vm.connect(admin).setStable(dai.target, true, 18, ethers.ZeroAddress, 10000))
			.to.be.revertedWith('VM: enabled needs pool')
	})

	it('reverts purchase on an inactive tier', async () => {
		const { vm, admin, operator, dai, wklc, router, alice, dev, amb, builders } = await deploySystem()
		await vm.connect(admin).setTier(0, 100, 1500, 'ipfs://light', false) // inactive
		await vm.connect(admin).setFeeRecipients(dev.address, amb.address, builders.address)
		await vm.connect(admin).setStable(dai.target, true, 18, ethers.Wallet.createRandom().address, 10000)
		await vm.connect(admin).setOperatorBounds(1000000000000n, 1000, 1000)
		await vm.connect(operator).setMaxTotalWeight(1000000000000n)
		await vm.connect(operator).setReferencePrice(dai.target, ethers.parseEther('500'))
		await vm.connect(operator).setSlippageBps(300)
		await router.setRate(dai.target, wklc.target, ethers.parseEther('500'))
		await wklc.mint(router.target, ethers.parseEther('1000000'))
		await dai.mint(alice.address, ethers.parseEther('100'))
		await dai.connect(alice).approve(vm.target, ethers.parseEther('100'))
		await expect(vm.connect(alice).purchase(0, dai.target, 9999999999n)).to.be.revertedWith('VM: tier inactive')
	})

	it('admin can rescue residual ERC20 to treasury', async () => {
		const { vm, admin, dai, treasury } = await deploySystem()
		await dai.mint(vm.target, ethers.parseEther('5'))
		await vm.connect(admin).rescueERC20(dai.target, treasury.address, ethers.parseEther('5'))
		expect(await dai.balanceOf(treasury.address)).to.equal(ethers.parseEther('5'))
	})

	it('two purchases accumulate totalWeight', async () => {
		const sys = await fullBuy() // alice bought tier0 (weight 150000)
		const { vm, dai, bob } = sys
		await dai.mint(bob.address, ethers.parseEther('100'))
		await dai.connect(bob).approve(vm.target, ethers.parseEther('100'))
		await vm.connect(bob).purchase(0, dai.target, 9999999999n)
		expect(await vm.totalWeight()).to.equal(300000n)
	})
})
