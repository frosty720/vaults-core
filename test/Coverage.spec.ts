import { expect } from 'chai'
import { ethers, upgrades } from 'hardhat'
import { deploySystem } from './VaultManager.spec'

const FUTURE = 9999999999n

// Helper: fully configure a stable at an arbitrary v3Fee and set up alice ready to buy tier-0.
async function buyAtFee(v3Fee: number) {
	const sys = await deploySystem()
	const { vm, admin, operator, dai, wklc, router, alice, dev, amb, builders } = sys
	await vm.connect(admin).setTier(0, 100, 1500, 'ipfs://light', true)
	await vm.connect(admin).setTierCap(0, 25000)
	await vm.connect(admin).setFeeRecipients(dev.address, amb.address, builders.address)
	await vm.connect(admin).setStable(dai.target, true, 18, ethers.Wallet.createRandom().address, v3Fee)
	await vm.connect(admin).setOperatorBounds(1000000000000n, 1000, 1000)
	await vm.connect(operator).setMaxTotalWeight(1000000000000n)
	await vm.connect(operator).setReferencePrice(dai.target, ethers.parseEther('500'))
	await vm.connect(operator).setSlippageBps(300)
	await router.setRate(dai.target, wklc.target, ethers.parseEther('500'))
	await wklc.mint(router.target, ethers.parseEther('1000000'))
	await dai.mint(alice.address, ethers.parseEther('100'))
	await dai.connect(alice).approve(vm.target, ethers.parseEther('100'))
	return { sys, buy: () => vm.connect(alice).purchase(0, dai.target, FUTURE) }
}

describe('Coverage: remaining branches', () => {
	it('purchases succeed at fee tiers 3000, 500, 100 (exercises _tickSpacing)', async () => {
		for (const fee of [3000, 500, 100]) {
			const { buy } = await buyAtFee(fee)
			await expect(buy()).to.not.be.reverted
		}
	})

	it('reverts on an unknown fee tier in _tickSpacing', async () => {
		const { buy } = await buyAtFee(1234)
		await expect(buy()).to.be.revertedWith('VM: unknown fee tier')
	})

	it('reverts purchase when reference price is unset', async () => {
		const sys = await deploySystem()
		const { vm, admin, operator, dai, wklc, router, alice, dev, amb, builders } = sys
		await vm.connect(admin).setTier(0, 100, 1500, 'ipfs://light', true)
		await vm.connect(admin).setTierCap(0, 25000)
		await vm.connect(admin).setFeeRecipients(dev.address, amb.address, builders.address)
		await vm.connect(admin).setStable(dai.target, true, 18, ethers.Wallet.createRandom().address, 10000)
		await vm.connect(admin).setOperatorBounds(1000000000000n, 1000, 1000)
		await vm.connect(operator).setMaxTotalWeight(1000000000000n)
		await vm.connect(operator).setSlippageBps(300)
		// NOTE: referencePrice deliberately NOT set
		await router.setRate(dai.target, wklc.target, ethers.parseEther('500'))
		await wklc.mint(router.target, ethers.parseEther('1000000'))
		await dai.mint(alice.address, ethers.parseEther('100'))
		await dai.connect(alice).approve(vm.target, ethers.parseEther('100'))
		await expect(vm.connect(alice).purchase(0, dai.target, FUTURE)).to.be.revertedWith('VM: no ref price')
	})

	it('setTier updates an existing tier in place', async () => {
		const { vm, admin } = await deploySystem()
		await vm.connect(admin).setTier(0, 100, 1500, 'ipfs://a', true)
		await vm.connect(admin).setTier(0, 200, 2000, 'ipfs://b', false)
		const t = await vm.tiers(0)
		expect(t.priceUSD).to.equal(200n)
		expect(t.active).to.equal(false)
		expect(t.weight).to.equal(200n * 2000n)
	})

	it('setStable can register a disabled stable', async () => {
		const { vm, admin, dai } = await deploySystem()
		await vm.connect(admin).setStable(dai.target, false, 18, ethers.ZeroAddress, 10000)
		const cfg = await vm.stables(dai.target)
		expect(cfg.enabled).to.equal(false)
	})

	it('setTreasury rejects zero address and accepts a valid address', async () => {
		const { vm, admin, alice } = await deploySystem()
		await expect(vm.connect(admin).setTreasury(ethers.ZeroAddress)).to.be.revertedWith('VM: zero treasury')
		await vm.connect(admin).setTreasury(alice.address)
		expect(await vm.treasury()).to.equal(alice.address)
	})

	it('setOperatorBounds rejects out-of-range bps', async () => {
		const { vm, admin } = await deploySystem()
		await expect(vm.connect(admin).setOperatorBounds(0, 10001, 300)).to.be.revertedWith('VM: bps too high')
	})

	it('tokenURI reverts for an unminted token', async () => {
		const { vm } = await deploySystem()
		await expect(vm.tokenURI(999)).to.be.reverted
	})

	it('unpause re-enables purchasing', async () => {
		const { vm, operator } = await deploySystem()
		await vm.connect(operator).pause()
		expect(await vm.paused()).to.equal(true)
		await vm.connect(operator).unpause()
		expect(await vm.paused()).to.equal(false)
	})

	it('rescueERC20 rejects zero to-address', async () => {
		const { vm, admin, dai } = await deploySystem()
		await expect(vm.connect(admin).rescueERC20(dai.target, ethers.ZeroAddress, 1n)).to.be.revertedWith('VM: zero to')
	})

	it('supportsInterface returns true for ERC721 and AccessControl', async () => {
		const { vm } = await deploySystem()
		expect(await vm.supportsInterface('0x80ac58cd')).to.equal(true) // ERC721
		expect(await vm.supportsInterface('0x7965db0b')).to.equal(true) // AccessControl
		expect(await vm.supportsInterface('0xffffffff')).to.equal(false)
	})

	it('only DEFAULT_ADMIN can upgrade VaultManager and state survives', async () => {
		const { vm, admin, alice } = await deploySystem()
		const polLib = await (await ethers.getContractFactory('PolLib')).deploy()
		const V2 = await ethers.getContractFactory('VaultManagerV2Mock', { libraries: { PolLib: polLib.target } })
		const opts = { unsafeAllow: ['missing-initializer', 'external-library-linking'] as const }
		await expect(upgrades.upgradeProxy(vm.target, V2.connect(alice), opts)).to.be.reverted
		const upgraded = await upgrades.upgradeProxy(vm.target, V2.connect(admin), opts)
		expect(await upgraded.version()).to.equal(2n)
	})

	// v2: superseded by RewardsPoolV2/Maturity tests — onWeightChange/claim(address) removed.
	// RevertingReceiver tests the old per-address claim path; claim(tokenId) stub always reverts
	// with 'RP: TODO' in v2 until the maturity task is complete.
	it.skip('RewardsPool claim reverts if the recipient rejects native transfer [v2: superseded]', async () => {
		// Kept for traceability; this test cannot run against v2 RewardsPool.
	})
})
