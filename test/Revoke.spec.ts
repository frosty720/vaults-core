import { expect } from 'chai'
import { ethers, upgrades } from 'hardhat'
import { deploySystem } from './VaultManager.spec'

const E = ethers.parseEther
const FUTURE = 9999999999n

// Admin revocation of vaults bought with illegitimately obtained funds (2026-08-21 KUSD incident):
// the NFT is burned, its weight leaves both contracts, and every KLC it had coming (pending and
// already-checkpointed) is forfeited back to the distributable pool for the remaining holders.
describe('Revoke — RewardsPool.revokeVault', () => {
	async function setup() {
		const [admin, updater, owner1, owner2] = await ethers.getSigners()
		const MockVM = await ethers.getContractFactory('MockVaultManagerForRewards')
		const vm = await MockVM.deploy()
		const RP = await ethers.getContractFactory('RewardsPool')
		const rp = await upgrades.deployProxy(RP, [admin.address, updater.address, await vm.getAddress()], { kind: 'uups' })
		await vm.setKlcUsd(E('1'))
		return { rp, vm, admin, updater, owner1, owner2 }
	}

	it('forfeits pending KLC, removes weight, and recycles it to the remaining vaults', async () => {
		const { rp, vm, updater, owner1, owner2 } = await setup()
		await vm.setOwner(1, owner1.address)
		await vm.setOwner(2, owner2.address)
		await rp.connect(updater).registerVault(1, 100, E('1000000'))
		await rp.connect(updater).registerVault(2, 100, E('1000000'))
		await owner1.sendTransaction({ to: await rp.getAddress(), value: E('200') }) // 100 each pending

		await expect(rp.connect(updater).revokeVault(1)).to.emit(rp, 'Revoked').withArgs(1, E('100'))

		expect(await rp.earned(1)).to.equal(0n)
		expect(await rp.isMatured(1)).to.equal(true)
		expect(await rp.vaultWeight(1)).to.equal(0n)
		expect(await rp.totalWeight()).to.equal(100n)
		// the 100 KLC vault 1 had coming is redistributed: vault 2 now earns all 200
		expect(await rp.earned(2)).to.equal(E('200'))
		const before = await ethers.provider.getBalance(owner2.address)
		const tx = await rp.connect(owner2).claim(2)
		const rc = await tx.wait()
		const gas = rc!.gasUsed * rc!.gasPrice
		expect((await ethers.provider.getBalance(owner2.address)) - before + gas).to.equal(E('200'))
		// and vault 1's owner gets nothing on claim
		await rp.connect(owner1).claim(1)
		expect(await rp.earned(1)).to.equal(0n)
	})

	it('also wipes KLC that was already checkpointed into accrued', async () => {
		const { rp, vm, updater, owner1, owner2 } = await setup()
		await vm.setOwner(1, owner1.address)
		await vm.setOwner(2, owner2.address)
		await rp.connect(updater).registerVault(1, 100, E('1000000'))
		await owner1.sendTransaction({ to: await rp.getAddress(), value: E('100') })
		await rp.mature(1) // checkpoint: accrued[1] = 100
		expect(await rp.accrued(1)).to.equal(E('100'))

		await expect(rp.connect(updater).revokeVault(1)).to.emit(rp, 'Revoked').withArgs(1, E('100'))
		expect(await rp.accrued(1)).to.equal(0n)
		expect(await rp.earned(1)).to.equal(0n)
		expect(await rp.totalWeight()).to.equal(0n)

		// the forfeited 100 KLC is distributable again: a vault registered afterwards picks it up
		await rp.connect(updater).registerVault(2, 100, E('1000000'))
		await owner1.sendTransaction({ to: await rp.getAddress(), value: E('1') })
		expect(await rp.earned(2)).to.equal(E('101'))
	})

	it('a revoked id cannot be re-registered', async () => {
		const { rp, vm, updater, owner1 } = await setup()
		await vm.setOwner(1, owner1.address)
		await rp.connect(updater).registerVault(1, 100, E('1000000'))
		await rp.connect(updater).revokeVault(1)
		await expect(rp.connect(updater).registerVault(1, 100, E('1000000'))).to.be.revertedWith('RP: already registered')
	})

	it('reverts for an unregistered id and for callers without WEIGHT_UPDATER_ROLE', async () => {
		const { rp, vm, updater, owner1 } = await setup()
		await expect(rp.connect(updater).revokeVault(7)).to.be.revertedWith('RP: not registered')
		await vm.setOwner(1, owner1.address)
		await rp.connect(updater).registerVault(1, 100, E('1000000'))
		await expect(rp.connect(owner1).revokeVault(1)).to.be.revertedWith(/AccessControl: account .* is missing role/)
	})
})

describe('Revoke — VaultManager.revokeVaults', () => {
	async function setup() {
		const sys = await deploySystem()
		const { vm, admin, operator, dai, wklc, router, dev, amb, builders } = sys
		// deploySystem wires the pool to a placeholder vaultManager; revoke/claim need the real one
		const RP = await ethers.getContractFactory('RewardsPool')
		const pool = await upgrades.deployProxy(RP, [admin.address, vm.target, vm.target], { kind: 'uups' })
		await vm.connect(admin).setRewardsPool(pool.target)
		sys.pool = pool
		await vm.connect(admin).setFeeRecipients(dev.address, amb.address, builders.address)
		await vm.connect(admin).setTier(0, 100, 1500, 'ipfs://light', true)
		await vm.connect(admin).setTierCap(0, 25000)
		await vm.connect(admin).setStable(dai.target, true, 18, ethers.Wallet.createRandom().address, 10000)
		await vm.connect(operator).setMaxTotalWeight(10n ** 12n)
		await vm.connect(operator).setReferencePrice(dai.target, E('500'))
		await vm.connect(operator).setPriceAnchor(dai.target)
		await vm.connect(operator).setSlippageBps(300)
		await (router as any).setRate(dai.target, wklc.target, E('500'))
		await (wklc as any).mint(router.target, E('1000000'))
		return sys
	}

	async function buy(sys: any, who: any): Promise<bigint> {
		const { vm, dai } = sys
		await (dai as any).mint(who.address, E('100'))
		await dai.connect(who).approve(vm.target, E('100'))
		const id = await vm.nextTokenId()
		await vm.connect(who)['purchase(uint8,address,uint256)'](0, dai.target, FUTURE)
		return id
	}

	it('admin burns the vault, drops its weight, forfeits its rewards; other holders keep theirs', async () => {
		const sys = await setup()
		const { vm, pool, admin, alice, bob } = sys
		const aliceId = await buy(sys, alice)
		const bobId = await buy(sys, bob)
		const weight = await vm.tierWeight(0)
		await admin.sendTransaction({ to: pool.target, value: E('50') }) // 25 each pending

		const pendingBefore = await pool.earned(aliceId) // ~25 KLC, minus integer-division dust
		expect(pendingBefore).to.be.closeTo(E('25'), 10n)
		await expect(vm.connect(admin).revokeVaults([aliceId]))
			.to.emit(vm, 'VaultRevoked').withArgs(aliceId, alice.address, pendingBefore)
			.and.to.emit(vm, 'Transfer').withArgs(alice.address, ethers.ZeroAddress, aliceId)

		await expect(vm.ownerOf(aliceId)).to.be.revertedWith('ERC721: invalid token ID')
		expect(await vm.balanceOf(alice.address)).to.equal(0n)
		expect(await vm.vaultWeight(aliceId)).to.equal(0n)
		expect(await vm.totalWeight()).to.equal(weight)
		expect(await pool.totalWeight()).to.equal(weight)
		expect(await pool.earned(aliceId)).to.equal(0n)
		expect(await pool.earned(bobId)).to.be.closeTo(E('50'), 10n) // bob now gets alice's forfeited 25 too
	})

	it('a revoked vault can never be claimed (ownerOf reverts) and keeps its id burned', async () => {
		const sys = await setup()
		const { vm, pool, admin, alice } = sys
		const id = await buy(sys, alice)
		await admin.sendTransaction({ to: pool.target, value: E('10') })
		await vm.connect(admin).revokeVaults([id])
		await expect(pool.connect(alice).claim(id)).to.be.revertedWith('ERC721: invalid token ID')
		await expect(vm.tokenURI(id)).to.be.revertedWith('ERC721: invalid token ID')
	})

	it('revokes several ids in one call and leaves the rest of the supply untouched', async () => {
		const sys = await setup()
		const { vm, pool, admin, alice, bob } = sys
		const a1 = await buy(sys, alice)
		const a2 = await buy(sys, alice)
		const b1 = await buy(sys, bob)
		const weight = await vm.tierWeight(0)
		await vm.connect(admin).revokeVaults([a1, a2])
		expect(await vm.balanceOf(alice.address)).to.equal(0n)
		expect(await vm.ownerOf(b1)).to.equal(bob.address)
		expect(await vm.totalWeight()).to.equal(weight)
		expect(await pool.totalWeight()).to.equal(weight)
		expect(await pool.vaultWeight(b1)).to.equal(weight)
	})

	it('non-admin cannot revoke and unknown ids revert', async () => {
		const sys = await setup()
		const { vm, admin, alice } = sys
		const id = await buy(sys, alice)
		await expect(vm.connect(alice).revokeVaults([id])).to.be.revertedWith(/AccessControl: account .* is missing role/)
		await expect(vm.connect(admin).revokeVaults([999n])).to.be.revertedWith('ERC721: invalid token ID')
	})
})
