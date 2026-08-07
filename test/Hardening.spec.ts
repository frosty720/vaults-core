import { expect } from 'chai'
import { ethers, upgrades } from 'hardhat'
import { deploySystem } from './VaultManager.spec'

const ZERO = ethers.ZeroAddress

// Tests for the security-analysis hardening pass (Slither/Aderyn findings):
//  - zero-address validation in both initializers
//  - events emitted by the admin/operator config setters
describe('Hardening: initializer zero-address checks', () => {
	it('RewardsPool.initialize reverts on zero admin, zero weightUpdater, or zero vaultManager', async () => {
		const [a, b] = await ethers.getSigners()
		const Pool = await ethers.getContractFactory('RewardsPool')
		// v2: initialize(admin, weightUpdater, vaultManager_) — 3 args, error string is 'RP: zero address'
		await expect(upgrades.deployProxy(Pool, [ZERO, a.address, b.address], { kind: 'uups' }))
			.to.be.revertedWith('RP: zero address')
		await expect(upgrades.deployProxy(Pool, [a.address, ZERO, b.address], { kind: 'uups' }))
			.to.be.revertedWith('RP: zero address')
		await expect(upgrades.deployProxy(Pool, [a.address, b.address, ZERO], { kind: 'uups' }))
			.to.be.revertedWith('RP: zero address')
	})

	it('RewardsPool.initialize succeeds with non-zero addresses', async () => {
		const [a, b, c] = await ethers.getSigners()
		const Pool = await ethers.getContractFactory('RewardsPool')
		// v2: 3-arg initialize(admin, weightUpdater, vaultManager_)
		const pool = await upgrades.deployProxy(Pool, [a.address, b.address, c.address], { kind: 'uups' })
		expect(await pool.hasRole(await pool.DEFAULT_ADMIN_ROLE(), a.address)).to.equal(true)
	})

	it('VaultManager.initialize reverts if any address arg is zero', async () => {
		const [admin, operator, treasury] = await ethers.getSigners()
		const ERC20 = await ethers.getContractFactory('MockERC20')
		const wklc = await ERC20.deploy('WKLC', 'WKLC', 18)
		const router = await (await ethers.getContractFactory('MockSwapRouter')).deploy()
		const npm = await (await ethers.getContractFactory('MockPositionManager')).deploy()
		const Pool = await ethers.getContractFactory('RewardsPool')
		// v2: initialize(admin, weightUpdater, vaultManager_) — 3 args
		const pool = await upgrades.deployProxy(Pool, [admin.address, admin.address, admin.address], { kind: 'uups' })
		const polLib = await (await ethers.getContractFactory('PolLib')).deploy()
		const VM = await ethers.getContractFactory('VaultManager', { libraries: { PolLib: polLib.target } })

		// Full valid arg tuple; we zero out one slot per case and expect a revert.
		const ok = [admin.address, operator.address, pool.target, treasury.address, wklc.target, router.target, npm.target]
		for (let i = 0; i < ok.length; i++) {
			const args = [...ok]
			args[i] = ZERO
			await expect(upgrades.deployProxy(VM, args, { kind: 'uups', unsafeAllow: ['external-library-linking'] }), `slot ${i} should revert`)
				.to.be.revertedWith('VM: zero address')
		}
	})
})

describe('Hardening: config setters emit events', () => {
	it('setStable emits StableConfigured', async () => {
		const { vm, admin, dai } = await deploySystem()
		const v3Pool = ethers.Wallet.createRandom().address
		await expect(vm.connect(admin).setStable(dai.target, true, 18, v3Pool, 10000))
			.to.emit(vm, 'StableConfigured').withArgs(dai.target, true, 18, v3Pool, 10000)
	})

	it('setFeeRecipients emits FeeRecipientsUpdated', async () => {
		const { vm, admin, dev, amb, builders } = await deploySystem()
		await expect(vm.connect(admin).setFeeRecipients(dev.address, amb.address, builders.address))
			.to.emit(vm, 'FeeRecipientsUpdated').withArgs(dev.address, amb.address, builders.address)
	})

	it('setTreasury emits TreasuryUpdated', async () => {
		const { vm, admin, alice } = await deploySystem()
		await expect(vm.connect(admin).setTreasury(alice.address))
			.to.emit(vm, 'TreasuryUpdated').withArgs(alice.address)
	})

	it('setOperatorBounds emits OperatorBoundsUpdated', async () => {
		const { vm, admin } = await deploySystem()
		await expect(vm.connect(admin).setOperatorBounds(1000n, 500, 300))
			.to.emit(vm, 'OperatorBoundsUpdated').withArgs(1000n, 500, 300)
	})

	it('setMaxTotalWeight emits MaxTotalWeightUpdated', async () => {
		const { vm, admin, operator } = await deploySystem()
		await vm.connect(admin).setOperatorBounds(1000n, 500, 300)
		await expect(vm.connect(operator).setMaxTotalWeight(800n))
			.to.emit(vm, 'MaxTotalWeightUpdated').withArgs(800n)
	})

	it('setReferencePrice emits ReferencePriceUpdated', async () => {
		const { vm, admin, operator, dai } = await deploySystem()
		await vm.connect(admin).setOperatorBounds(0, 500, 300)
		await expect(vm.connect(operator).setReferencePrice(dai.target, ethers.parseEther('500')))
			.to.emit(vm, 'ReferencePriceUpdated').withArgs(dai.target, ethers.parseEther('500'))
	})

	it('setSlippageBps emits SlippageBpsUpdated', async () => {
		const { vm, admin, operator } = await deploySystem()
		await vm.connect(admin).setOperatorBounds(0, 0, 300)
		await expect(vm.connect(operator).setSlippageBps(250))
			.to.emit(vm, 'SlippageBpsUpdated').withArgs(250)
	})
})
