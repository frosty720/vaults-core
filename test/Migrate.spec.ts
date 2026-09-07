import { expect } from 'chai'
import { ethers, upgrades } from 'hardhat'
import { deploySystem } from './VaultManager.spec'

const E = ethers.parseEther
const FUTURE = 9999999999n

// Relaunch (chain 3890): vaults are re-created from the snapshot, not re-bought.
//  - RewardsPool.migrateVault: one-shot restore of weight/cap/earnedUsd/accrued for an id (funds earmarked)
//  - RewardsPool.pause/unpause (PAUSER_ROLE): freezes claims, nothing else
//  - VaultManager.migrateVaults: admin re-mints snapshot ids to their owners + sponsor tree, one-way closeMigration()
describe('Migrate — RewardsPool', () => {
	async function setup() {
		const [admin, updater, owner1, owner2, pauser] = await ethers.getSigners()
		const MockVM = await ethers.getContractFactory('MockVaultManagerForRewards')
		const vm = await MockVM.deploy()
		const RP = await ethers.getContractFactory('RewardsPool')
		const rp = await upgrades.deployProxy(RP, [admin.address, updater.address, await vm.getAddress()], { kind: 'uups' })
		await vm.setKlcUsd(E('1'))
		await rp.connect(admin).grantRole(await rp.PAUSER_ROLE(), pauser.address)
		return { rp, vm, admin, updater, owner1, owner2, pauser }
	}

	it('migrateVault restores accrued/earnedUsd/cap/weight and the accrued KLC is claimable (earmarked, not redistributed)', async () => {
		const { rp, vm, updater, owner1, owner2 } = await setup()
		await vm.setOwner(1, owner1.address); await vm.setOwner(2, owner2.address)
		// fund the carried accruals BEFORE migrating (the script does this with the snapshot total)
		await updater.sendTransaction({ to: await rp.getAddress(), value: E('30') }) // 10 + 20 carried
		await rp.connect(updater).migrateVault(1, 100, E('1000'), E('10'), E('5'), false)
		await rp.connect(updater).migrateVault(2, 300, E('1000'), E('20'), E('7'), false)
		expect(await rp.vaultWeight(1)).to.equal(100n); expect(await rp.vaultWeight(2)).to.equal(300n)
		expect(await rp.totalWeight()).to.equal(400n)
		expect(await rp.capUsdOf(1)).to.equal(E('1000')); expect(await rp.earnedUsdOf(2)).to.equal(E('7'))
		expect(await rp.earned(1)).to.equal(E('10')); expect(await rp.earned(2)).to.equal(E('20'))
		// new rewards distribute by weight on top of the carried amounts (no double counting of the 30)
		await updater.sendTransaction({ to: await rp.getAddress(), value: E('40') })
		expect(await rp.earned(1)).to.equal(E('20')) // 10 carried + 40*100/400
		expect(await rp.earned(2)).to.equal(E('50')) // 20 carried + 40*300/400
		const b = await ethers.provider.getBalance(owner2.address)
		const rc = await (await rp.connect(owner2).claim(2)).wait()
		expect((await ethers.provider.getBalance(owner2.address)) - b + rc!.gasUsed * rc!.gasPrice).to.equal(E('50'))
	})

	it('migrateVault of a matured vault keeps it matured with zero weight but claimable accrued', async () => {
		const { rp, vm, updater, owner1 } = await setup()
		await vm.setOwner(1, owner1.address)
		await updater.sendTransaction({ to: await rp.getAddress(), value: E('3') })
		await rp.connect(updater).migrateVault(1, 100, E('100'), E('3'), E('100'), true)
		expect(await rp.isMatured(1)).to.equal(true); expect(await rp.vaultWeight(1)).to.equal(0n); expect(await rp.totalWeight()).to.equal(0n)
		expect(await rp.earned(1)).to.equal(E('3'))
	})

	it('migrateVault refuses unfunded accruals, duplicate ids, and non-updaters', async () => {
		const { rp, vm, updater, owner1 } = await setup()
		await vm.setOwner(1, owner1.address)
		await expect(rp.connect(updater).migrateVault(1, 100, E('1000'), E('10'), 0, false)).to.be.revertedWith('RP: accrued not funded')
		await updater.sendTransaction({ to: await rp.getAddress(), value: E('10') })
		await rp.connect(updater).migrateVault(1, 100, E('1000'), E('10'), 0, false)
		await expect(rp.connect(updater).migrateVault(1, 100, E('1000'), 0, 0, false)).to.be.revertedWith('RP: already registered')
		await expect(rp.connect(owner1).migrateVault(3, 100, E('1000'), 0, 0, false)).to.be.revertedWith(/AccessControl: account .* is missing role/)
	})

	it('PAUSER_ROLE pauses claims only; admin/others cannot; unpause restores', async () => {
		const { rp, vm, updater, owner1, pauser, admin } = await setup()
		await vm.setOwner(1, owner1.address)
		await rp.connect(updater).registerVault(1, 100, E('1000'))
		await updater.sendTransaction({ to: await rp.getAddress(), value: E('5') })
		await expect(rp.connect(owner1).pause()).to.be.revertedWith(/AccessControl: account .* is missing role/)
		await expect(rp.connect(admin).pause()).to.be.revertedWith(/AccessControl: account .* is missing role/) // two-tier: admin != pauser
		await rp.connect(pauser).pause()
		expect(await rp.claimsPaused()).to.equal(true)
		await expect(rp.connect(owner1).claim(1)).to.be.revertedWith('RP: paused')
		await expect(rp.connect(owner1).claimMany([1])).to.be.revertedWith('RP: paused')
		await rp.mature(1) // checkpoints still allowed
		await rp.connect(pauser).unpause()
		await rp.connect(owner1).claim(1)
		expect(await rp.earned(1)).to.equal(0n)
	})
})

describe('Migrate — VaultManager', () => {
	async function setup() {
		const sys = await deploySystem()
		const { vm, admin, operator, dai, wklc, router, dev, amb, builders } = sys
		const RP = await ethers.getContractFactory('RewardsPool')
		const pool = await upgrades.deployProxy(RP, [admin.address, vm.target, vm.target], { kind: 'uups' })
		await vm.connect(admin).setRewardsPool(pool.target)
		sys.pool = pool
		await vm.connect(admin).setFeeRecipients(dev.address, amb.address, builders.address)
		await vm.connect(admin).setTier(0, 50, 3000, 'ipfs://0', true)
		await vm.connect(admin).setTier(1, 100, 4000, 'ipfs://1', true)
		await vm.connect(admin).setTierCap(0, 15000); await vm.connect(admin).setTierCap(1, 20000)
		await vm.connect(admin).setStable(dai.target, true, 18, ethers.Wallet.createRandom().address, 10000)
		await vm.connect(operator).setMaxTotalWeight(10n ** 12n)
		await vm.connect(operator).setReferencePrice(dai.target, E('5'))
		await vm.connect(operator).setPriceAnchor(dai.target)
		await (router as any).setRate(dai.target, wklc.target, E('5'))
		await (wklc as any).mint(router.target, E('1000000'))
		return sys
	}
	const entry = (id: bigint, owner: string, tier: number, sponsor: string, accrued = 0n, earnedUsd = 0n, capUsd = E('100'), matured = false) => ({ id, owner, tier, sponsor, accruedKlc: accrued, earnedUsd, capUsd, matured })

	it('admin re-mints snapshot ids to owners with tier/weight, sponsor tree and carried accruals', async () => {
		const sys = await setup(); const { vm, pool, admin, alice, bob } = sys
		await admin.sendTransaction({ to: pool.target, value: E('7') }) // carried accruals total
		const w0 = await vm.tierWeight(0), w1 = await vm.tierWeight(1)
		await expect(vm.connect(admin).migrateVaults([
			entry(5n, alice.address, 0, ethers.ZeroAddress, E('2')),
			entry(9n, bob.address, 1, alice.address, E('5'), E('3'), E('200')),
		])).to.emit(vm, 'VaultMigrated').withArgs(5n, alice.address, 0).and.to.emit(vm, 'VaultMigrated').withArgs(9n, bob.address, 1)
		expect(await vm.ownerOf(5)).to.equal(alice.address); expect(await vm.ownerOf(9)).to.equal(bob.address)
		expect(await vm.tierOf(9)).to.equal(1); expect(await vm.vaultWeight(5)).to.equal(w0); expect(await vm.vaultWeight(9)).to.equal(w1)
		expect(await vm.totalWeight()).to.equal(w0 + w1); expect(await pool.totalWeight()).to.equal(w0 + w1)
		expect(await vm.sponsorOf(bob.address)).to.equal(alice.address); expect(await vm.sponsorOf(alice.address)).to.equal(ethers.ZeroAddress)
		expect(await pool.earned(5)).to.equal(E('2')); expect(await pool.earned(9)).to.equal(E('5')); expect(await pool.earnedUsdOf(9)).to.equal(E('3')); expect(await pool.capUsdOf(9)).to.equal(E('200'))
		expect(await vm.nextTokenId()).to.equal(10n) // next sale continues after the highest migrated id
	})

	it('closeMigration is one-way and blocks further migration; purchases then continue from the next id', async () => {
		const sys = await setup(); const { vm, admin, alice, dai } = sys
		await vm.connect(admin).migrateVaults([entry(3n, alice.address, 0, ethers.ZeroAddress)])
		await vm.connect(admin).closeMigration()
		expect(await vm.migrationClosed()).to.equal(true)
		await expect(vm.connect(admin).migrateVaults([entry(4n, alice.address, 0, ethers.ZeroAddress)])).to.be.revertedWith('VM: migration closed')
		await (dai as any).mint(alice.address, E('50')); await dai.connect(alice).approve(vm.target, E('50'))
		await vm.connect(alice)['purchase(uint8,address,uint256)'](0, dai.target, FUTURE)
		expect(await vm.ownerOf(4)).to.equal(alice.address)
	})

	it('non-admin cannot migrate; duplicate id reverts; sponsor is sticky (not overwritten)', async () => {
		const sys = await setup(); const { vm, admin, alice, bob } = sys
		await expect(vm.connect(alice).migrateVaults([entry(1n, alice.address, 0, ethers.ZeroAddress)])).to.be.revertedWith(/AccessControl: account .* is missing role/)
		await vm.connect(admin).migrateVaults([entry(1n, alice.address, 0, bob.address)])
		await expect(vm.connect(admin).migrateVaults([entry(1n, alice.address, 0, ethers.ZeroAddress)])).to.be.revertedWith('ERC721: token already minted')
		await vm.connect(admin).migrateVaults([entry(2n, alice.address, 0, admin.address)]) // second vault, different sponsor given
		expect(await vm.sponsorOf(alice.address)).to.equal(bob.address) // first one sticks
	})
})
