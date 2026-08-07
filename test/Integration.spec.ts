import { expect } from 'chai'
import { ethers } from 'hardhat'
import { deploySystem } from './VaultManager.spec'

const FUTURE = 9999999999n

describe('Integration: vault lifecycle', () => {
	// v2: superseded by RewardsPoolV2/Maturity tests.
	// The per-address earned(address)/claim()/weightOf(address) API is gone in RewardsPool v2.
	// All accrual/claim assertions below are commented out pending the maturity task.
	it('two-tier purchase succeeds; totalWeight accumulates proportionally', async () => {
		const sys = await deploySystem()
		const { vm, pool, admin, operator, dai, wklc, router, alice, bob, dev, amb, builders } = sys
		await vm.connect(admin).setTier(0, 100, 1500, 'ipfs://light', true)      // weight 150000
		await vm.connect(admin).setTierCap(0, 25000)
		await vm.connect(admin).setTier(1, 100000, 3500, 'ipfs://genesis', true) // weight 350000000
		await vm.connect(admin).setTierCap(1, 35000)
		await vm.connect(admin).setFeeRecipients(dev.address, amb.address, builders.address)
		await vm.connect(admin).setStable(dai.target, true, 18, ethers.Wallet.createRandom().address, 10000)
		await vm.connect(admin).setOperatorBounds(1000000000000n, 1000, 1000)
		await vm.connect(operator).setMaxTotalWeight(1000000000000n)
		await vm.connect(operator).setReferencePrice(dai.target, ethers.parseEther('500'))
		await vm.connect(operator).setSlippageBps(300)
		await router.setRate(dai.target, wklc.target, ethers.parseEther('500'))
		await wklc.mint(router.target, ethers.parseEther('100000000'))

		await dai.mint(alice.address, ethers.parseEther('100'))
		await dai.connect(alice).approve(vm.target, ethers.parseEther('100'))
		await vm.connect(alice).purchase(0, dai.target, FUTURE)
		await dai.mint(bob.address, ethers.parseEther('100000'))
		await dai.connect(bob).approve(vm.target, ethers.parseEther('100000'))
		await vm.connect(bob).purchase(1, dai.target, FUTURE)

		// totalWeight = 150000 + 350000000 = 350150000
		expect(await vm.totalWeight()).to.equal(350150000n)
		expect(await pool.totalWeight()).to.equal(350150000n)

		// v2: superseded by RewardsPoolV2/Maturity tests — per-address earned/claim removed.
		// await admin.sendTransaction({ to: pool.target, value: ethers.parseEther('350150') })
		// expect(await pool.earned(alice.address)).to.equal(ethers.parseEther('150'))
		// expect(await pool.earned(bob.address)).to.equal(ethers.parseEther('350000'))
		// await expect(pool.connect(alice).claim()).to.changeEtherBalance(alice, ethers.parseEther('150'))

		// Transfer still works; v2 per-vault weight stays in pool.
		await vm.connect(bob).transferFrom(bob.address, alice.address, 2)
		expect(await vm.ownerOf(2)).to.equal(alice.address)
		// v2: vaultWeight(2) remains in pool (not redistributed on transfer — travels with NFT).
		expect(await pool.vaultWeight(2)).to.equal(350000000n)

		// v2: superseded by RewardsPoolV2/Maturity tests — per-address earned after transfer removed.
		// await admin.sendTransaction({ to: pool.target, value: ethers.parseEther('350150') })
		// expect(await pool.earned(alice.address)).to.be.closeTo(ethers.parseEther('350150'), ethers.parseEther('0.001'))
	})
})
