import { expect } from 'chai'
import { ethers, upgrades } from 'hardhat'
import { deploySystem } from './VaultManager.spec'

const FUTURE = 9999999999n
const BIG = 10n ** 18n

// Regression tests for the security-audit hardening pass.
//   H-1  swap minOut decimals normalization (6-decimal stable slippage protection)
//   M-1  CEI: weight bookkeeping registered before the _safeMint receiver callback
//   H-2  leftover POL dust swept to treasury after a partial mint
//   F-7  per-token weight snapshot survives a post-mint tier-weight edit
//   misc input validation (setStable decimals, setTier zero params)

// --- H-1: a 6-decimal stable must still get a correctly-scaled swap floor ---
// referencePrice is defined as WKLC(1e18) per 1.0 whole stable, in 1e18 fixed point, regardless of
// the stable's token decimals. swapIn is normalized to 18 decimals before the floor is computed.
async function configure6dp(routerRate: bigint) {
	const sys = await deploySystem()
	const { vm, admin, operator, wklc, router, alice, dev, amb, builders } = sys
	const usdc = await (await ethers.getContractFactory('MockERC20')).deploy('USDC', 'USDC', 6)
	await vm.connect(admin).setTier(0, 100, 1500, 'ipfs://light', true)
	await vm.connect(admin).setTierCap(0, 25000)
	await vm.connect(admin).setFeeRecipients(dev.address, amb.address, builders.address)
	await vm.connect(admin).setStable(usdc.target, true, 6, ethers.Wallet.createRandom().address, 10000)
	await vm.connect(admin).setOperatorBounds(BIG, 1000, 1000)
	await vm.connect(operator).setMaxTotalWeight(BIG)
	await vm.connect(operator).setReferencePrice(usdc.target, ethers.parseEther('2')) // 1 USDC = 2 WKLC
	await vm.connect(operator).setSlippageBps(300) // 3%
	await router.setRate(usdc.target, wklc.target, routerRate)
	await wklc.mint(router.target, ethers.parseEther('10000000'))
	const price = 100n * 10n ** 6n // 100 USDC (6 dp)
	await usdc.mint(alice.address, price)
	await usdc.connect(alice).approve(vm.target, price)
	return { ...sys, usdc, buy: () => vm.connect(alice).purchase(0, usdc.target, FUTURE) }
}

describe('Audit H-1: swap slippage floor is decimals-correct for 6-dp stables', () => {
	// swapIn = 45.5 USDC (45_500_000). Fair output @ 2 WKLC/USDC = 91e18 WKLC.
	// minOut = 45.5e18 * 2e18/1e18 * 0.97 = 88.27e18.
	// Fair router rate "out per 1e18 in" = 2e30 -> output 91e18 >= minOut, must succeed.
	it('a fairly-priced swap succeeds (floor scaled to 18 decimals)', async () => {
		const { buy } = await configure6dp(2n * 10n ** 30n)
		await expect(buy()).to.not.be.reverted
	})

	// Under-delivering router (sandwich) -> output 86.45e18 < minOut 88.27e18 -> must revert.
	// Pre-fix the floor was ~8.8e7 (10^12 too small), so this swap would have passed unprotected.
	it('an under-delivering swap is rejected by the floor (was unprotected pre-fix)', async () => {
		const { buy } = await configure6dp(19n * 10n ** 29n) // 1.9e30
		await expect(buy()).to.be.revertedWith('MockRouter: insufficient output')
	})
})

// --- H-2: leftover POL dust after a partial full-range mint is swept to the treasury ---
async function deployWithPartialNPM() {
	const [admin, operator, treasury, alice, , dev, amb, builders] = await ethers.getSigners()
	const ERC20 = await ethers.getContractFactory('MockERC20')
	const wklc = await ERC20.deploy('WKLC', 'WKLC', 18)
	const dai = await ERC20.deploy('DAI', 'DAI', 18)
	const router = await (await ethers.getContractFactory('MockSwapRouter')).deploy()
	const npm = await (await ethers.getContractFactory('PartialPositionManager')).deploy()
	const Pool = await ethers.getContractFactory('RewardsPool')
	// v2: initialize(admin, weightUpdater, vaultManager_). Admin used as placeholder for vaultManager_.
	const pool = await upgrades.deployProxy(Pool, [admin.address, admin.address, admin.address], { kind: 'uups' })
	const polLib = await (await ethers.getContractFactory('PolLib')).deploy()
	const VM = await ethers.getContractFactory('VaultManager', { libraries: { PolLib: polLib.target } })
	const vm = await upgrades.deployProxy(VM, [
		admin.address, operator.address, pool.target, treasury.address, wklc.target, router.target, npm.target,
	], { kind: 'uups', unsafeAllow: ['external-library-linking'] })
	await pool.connect(admin).grantRole(await pool.WEIGHT_UPDATER_ROLE(), vm.target)
	await vm.connect(admin).setTier(0, 100, 1500, 'ipfs://light', true)
	await vm.connect(admin).setTierCap(0, 25000)
	await vm.connect(admin).setFeeRecipients(dev.address, amb.address, builders.address)
	await vm.connect(admin).setStable(dai.target, true, 18, ethers.Wallet.createRandom().address, 10000)
	await vm.connect(admin).setOperatorBounds(BIG, 1000, 500)
	await (vm as any).connect(admin).initializeV2() // sets buyImpactBps=300, minBuyUsd=100
	await (vm as any).connect(admin).initializeV3(amb.address) // 80/20 + MLM; daoTreasury = amb (kept distinct from POL treasury)
	await vm.connect(operator).setMaxTotalWeight(BIG)
	await vm.connect(operator).setReferencePrice(dai.target, ethers.parseEther('500'))
	await vm.connect(operator).setSlippageBps(300)
	await router.setRate(dai.target, wklc.target, ethers.parseEther('500'))
	await wklc.mint(router.target, ethers.parseEther('10000000'))
	return { vm, pool, npm, wklc, dai, router, admin, operator, treasury, alice }
}

describe('Audit H-2: un-consumed POL dust is swept to the treasury', () => {
	it('sweeps the leftover stable and WKLC to treasury, leaving zero in the manager', async () => {
		const { vm, npm, wklc, dai, treasury, alice } = await deployWithPartialNPM()
		await npm.setConsumeBps(6000) // mint consumes 60%, 40% refunded to the manager
		const price = ethers.parseEther('100')
		await dai.mint(alice.address, price)
		await dai.connect(alice).approve(vm.target, price)
		await vm.connect(alice).purchase(0, dai.target, FUTURE)

		// 80% POL → polAmount = $80, a = P/2 = $40 -> wklcOut = 40 * 500 = 20000; lpStable = 40, lpWklc = 20000.
		// NPM consumes 60%, refunds 40% of each. Stable dust is swept to treasury; refunded WKLC
		// now STAYS in the manager as the protocol POL reserve (v3 design — WKLC is never swept).
		expect(await dai.balanceOf(vm.target)).to.equal(0n)
		expect(await dai.balanceOf(treasury.address)).to.equal(ethers.parseEther('16')) // 40 * 40%
		expect(await wklc.balanceOf(vm.target)).to.equal(ethers.parseEther('8000')) // 20000 * 40%, kept as reserve
		expect(await wklc.balanceOf(treasury.address)).to.equal(0n) // WKLC never swept
	})
})

// --- M-1: CEI — weight is registered before the ERC721 receiver callback ---
async function configured18() {
	const sys = await deploySystem()
	const { vm, admin, operator, dai, wklc, router, dev, amb, builders } = sys
	await vm.connect(admin).setTier(0, 100, 1500, 'ipfs://light', true)
	await vm.connect(admin).setTierCap(0, 25000)
	await vm.connect(admin).setFeeRecipients(dev.address, amb.address, builders.address)
	await vm.connect(admin).setStable(dai.target, true, 18, ethers.Wallet.createRandom().address, 10000)
	await vm.connect(admin).setOperatorBounds(BIG, 1000, 500)
	await vm.connect(operator).setMaxTotalWeight(BIG)
	await vm.connect(operator).setReferencePrice(dai.target, ethers.parseEther('500'))
	await vm.connect(operator).setSlippageBps(300)
	await router.setRate(dai.target, wklc.target, ethers.parseEther('500'))
	await wklc.mint(router.target, ethers.parseEther('10000000'))
	return sys
}

describe('Audit M-1: weight bookkeeping precedes the _safeMint callback (CEI)', () => {
	it('a contract buyer observes its weight already registered during onERC721Received', async () => {
		const { vm, pool, dai } = await configured18()
		const probe = await (await ethers.getContractFactory('WeightProbeReceiver')).deploy()
		await dai.mint(probe.target, ethers.parseEther('100'))
		await probe.buy(vm.target, pool.target, dai.target, 0, FUTURE)

		expect(await probe.callbackFired()).to.equal(true)
		// tier-0 weight = 100 * 1500 = 150000. Both counters must already reflect it at callback time.
		expect(await probe.seenTotalWeight()).to.equal(150000n)
		// v2: seenPoolWeight uses pool.vaultWeight(tokenId) — minted tokenId is 1.
		expect(await probe.seenPoolWeight()).to.equal(150000n)
		// v2: per-vault storage; check vaultWeight(1) instead of weightOf(address).
		expect(await pool.vaultWeight(1)).to.equal(150000n)
	})
})

// --- F-7: per-token weight snapshot survives an admin tier-weight edit after mint ---
describe('Audit F-7: transfer uses the mint-time weight snapshot, not the live tier weight', () => {
	it('moves the original weight on transfer even after the tier weight is changed', async () => {
		const { vm, pool, admin, operator, dai, alice, bob } = await configured18()
		await dai.mint(alice.address, ethers.parseEther('100'))
		await dai.connect(alice).approve(vm.target, ethers.parseEther('100'))
		await vm.connect(alice).purchase(0, dai.target, FUTURE) // token 1, snapshot weight 150000

		// Admin edits tier 0 to a heavier weight AFTER the NFT exists.
		await vm.connect(admin).setTier(0, 200, 2000, 'ipfs://heavier', true) // new tier weight = 400000
		expect(await vm.tierWeight(0)).to.equal(400000n)
		expect(await vm.vaultWeight(1)).to.equal(150000n) // snapshot unchanged

		// Pre-fix this used the live 400000 and reverted on underflow (alice only holds 150000).
		// v2: transfers no longer call into RewardsPool — per-vault state travels with NFT.
		await vm.connect(alice).transferFrom(alice.address, bob.address, 1)
		// v2: vaultWeight is per-tokenId; pool totalWeight is unaffected by transfers.
		expect(await pool.vaultWeight(1)).to.equal(150000n)
		expect(await pool.totalWeight()).to.equal(150000n)
		void operator
	})
})

// --- misc input validation ---
describe('Audit: input validation hardening', () => {
	it('setStable rejects decimals > 18', async () => {
		const { vm, admin, dai } = await deploySystem()
		await expect(
			vm.connect(admin).setStable(dai.target, true, 19, ethers.Wallet.createRandom().address, 10000)
		).to.be.revertedWith('VM: decimals too high')
	})

	it('setTier rejects zero priceUSD or zero aprBps', async () => {
		const { vm, admin } = await deploySystem()
		await expect(vm.connect(admin).setTier(0, 0, 1500, 'ipfs://x', true)).to.be.revertedWith('VM: zero tier params')
		await expect(vm.connect(admin).setTier(0, 100, 0, 'ipfs://x', true)).to.be.revertedWith('VM: zero tier params')
	})
})
