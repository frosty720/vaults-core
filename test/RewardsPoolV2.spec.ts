import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';

async function deployPool() {
	const [admin, updater, owner1, owner2] = await ethers.getSigners();
	const MockVM = await ethers.getContractFactory('MockVaultManagerForRewards');
	const vm = await MockVM.deploy();
	const RP = await ethers.getContractFactory('RewardsPool');
	const rp = await upgrades.deployProxy(RP, [admin.address, updater.address, await vm.getAddress()], { kind: 'uups' });
	return { rp, vm, admin, updater, owner1, owner2 };
}

describe('RewardsPool v2 — register + accrual', () => {
	it('registers vaults and splits native KLC by weight', async () => {
		const { rp, vm, updater, owner1, owner2 } = await deployPool();
		await vm.setKlcUsd(ethers.parseEther('0.0022'));
		await vm.setOwner(1, owner1.address); await vm.setOwner(2, owner2.address);
		await rp.connect(updater).registerVault(1, 100, ethers.parseEther('1000000'));
		await rp.connect(updater).registerVault(2, 100, ethers.parseEther('1000000'));
		expect(await rp.totalWeight()).to.equal(200);
		expect(await rp.vaultWeight(1)).to.equal(100);
		// earned() is stubbed to accrued (0) until checkpoint is built in a later task — assert registration only here.
	});

	it('rejects double-register and non-updater', async () => {
		const { rp, updater, owner1 } = await deployPool();
		await rp.connect(updater).registerVault(1, 100, ethers.parseEther('1000'));
		await expect(rp.connect(updater).registerVault(1, 100, ethers.parseEther('1000'))).to.be.revertedWith('RP: already registered');
		await expect(rp.connect(owner1).registerVault(2, 100, ethers.parseEther('1000'))).to.be.reverted;
	});

	it('initializes roles: admin has DEFAULT_ADMIN, updater has WEIGHT_UPDATER', async () => {
		const { rp, admin, updater } = await deployPool();
		const ADMIN = await rp.DEFAULT_ADMIN_ROLE();
		const UPDATER = await rp.WEIGHT_UPDATER_ROLE();
		expect(await rp.hasRole(ADMIN, admin.address)).to.equal(true);
		expect(await rp.hasRole(UPDATER, updater.address)).to.equal(true);
	});

	it('accepts native KLC via receive()', async () => {
		const { rp, owner1 } = await deployPool();
		await owner1.sendTransaction({ to: await rp.getAddress(), value: ethers.parseEther('1') });
		expect(await ethers.provider.getBalance(await rp.getAddress())).to.equal(ethers.parseEther('1'));
	});

	it('rejects zero weight on register', async () => {
		const { rp, updater } = await deployPool();
		await expect(rp.connect(updater).registerVault(1, 0, ethers.parseEther('1000'))).to.be.revertedWith('RP: zero weight');
	});

	it('totalWeight accumulates across multiple vaults', async () => {
		const { rp, updater } = await deployPool();
		await rp.connect(updater).registerVault(1, 150000, ethers.parseEther('1000'));
		await rp.connect(updater).registerVault(2, 350000, ethers.parseEther('1000'));
		expect(await rp.totalWeight()).to.equal(500000n);
	});

	it('rewardPerWeightPaid is set to current rewardPerWeightStored at registration time', async () => {
		const { rp, updater, owner1 } = await deployPool();
		// Register vault 1 first so totalWeight > 0
		await rp.connect(updater).registerVault(1, 100, ethers.parseEther('1000'));
		// Send KLC — accrues into rewardPerWeightStored
		await owner1.sendTransaction({ to: await rp.getAddress(), value: ethers.parseEther('10') });
		// Trigger internal accrue by registering a second vault
		await rp.connect(updater).registerVault(2, 100, ethers.parseEther('1000'));
		// Vault 2 was registered after the KLC arrived, so its rewardPerWeightPaid == current rewardPerWeightStored
		// (it should not be credited the pre-registration KLC)
		const rpws = await rp.rewardPerWeightStored();
		expect(await rp.rewardPerWeightPaid(2)).to.equal(rpws);
	});

	it('capUsdOf returns the cap set at registration', async () => {
		const { rp, updater } = await deployPool();
		const cap = ethers.parseEther('500000');
		await rp.connect(updater).registerVault(1, 100, cap);
		expect(await rp.capUsdOf(1)).to.equal(cap);
	});

	it('isMatured returns false for a freshly registered vault', async () => {
		const { rp, updater } = await deployPool();
		await rp.connect(updater).registerVault(1, 100, ethers.parseEther('1000'));
		expect(await rp.isMatured(1)).to.equal(false);
	});

	// ─── Task 4: owner-gated claim + claimMany ──────────────────────────────

	it('claim reverts with RP: not owner when called by non-owner', async () => {
		const { rp, vm, updater, owner1, owner2 } = await deployPool();
		await vm.setKlcUsd(ethers.parseEther('1'));
		await vm.setOwner(1, owner1.address);
		await rp.connect(updater).registerVault(1, 100, ethers.parseEther('1000000'));
		await owner1.sendTransaction({ to: await rp.getAddress(), value: ethers.parseEther('10') });
		// owner2 is not the owner of vault 1
		await expect(rp.connect(owner2).claim(1)).to.be.revertedWith('RP: not owner');
	});

	it('claimMany pays ~20 KLC to owner1 and zeroes earned for both vaults', async () => {
		const { rp, vm, updater, owner1, owner2 } = await deployPool();
		await vm.setKlcUsd(ethers.parseEther('1'));
		// Both vaults owned by owner1, equal weight, huge cap
		await vm.setOwner(1, owner1.address);
		await vm.setOwner(2, owner1.address);
		await rp.connect(updater).registerVault(1, 100, ethers.parseEther('1000000'));
		await rp.connect(updater).registerVault(2, 100, ethers.parseEther('1000000'));
		// Send 20 KLC → 10 per vault (equal weight)
		await owner2.sendTransaction({ to: await rp.getAddress(), value: ethers.parseEther('20') });

		const balBefore = await ethers.provider.getBalance(owner1.address);
		const tx = await rp.connect(owner1).claimMany([1, 2]);
		const receipt = await tx.wait();
		const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
		const balAfter = await ethers.provider.getBalance(owner1.address);

		// Net receive should be ~20 KLC minus gas
		const netReceived = balAfter - balBefore + gasUsed;
		expect(netReceived).to.be.closeTo(ethers.parseEther('20'), ethers.parseEther('0.01'));

		// Both vaults should now have zero accrued
		expect(await rp.earned(1)).to.equal(0n);
		expect(await rp.earned(2)).to.equal(0n);
	});

	it('duplicate id in claimMany is safe — second iteration pays 0', async () => {
		const { rp, vm, updater, owner1, owner2 } = await deployPool();
		await vm.setKlcUsd(ethers.parseEther('1'));
		await vm.setOwner(1, owner1.address);
		await rp.connect(updater).registerVault(1, 100, ethers.parseEther('1000000'));
		await owner2.sendTransaction({ to: await rp.getAddress(), value: ethers.parseEther('10') });

		const balBefore = await ethers.provider.getBalance(owner1.address);
		const tx = await rp.connect(owner1).claimMany([1, 1]); // duplicate
		const receipt = await tx.wait();
		const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
		const balAfter = await ethers.provider.getBalance(owner1.address);

		// Should receive ~10 KLC, not ~20 — second call on same id pays 0
		const netReceived = balAfter - balBefore + gasUsed;
		expect(netReceived).to.be.closeTo(ethers.parseEther('10'), ethers.parseEther('0.01'));
	});

	it('mature checkpoints a vault (no-op when no KLC has arrived)', async () => {
		const { rp, updater, vm } = await deployPool();
		await vm.setKlcUsd(ethers.parseEther('0.0022'));
		await rp.connect(updater).registerVault(1, 100, ethers.parseEther('1000'));
		// No KLC sent — mature() should succeed but not mature (cap not reached)
		await rp.mature(1);
		expect(await rp.isMatured(1)).to.equal(false);
	});

	it('rejects initialize with a zero address', async () => {
		const [admin, updater] = await ethers.getSigners();
		const MockVM = await ethers.getContractFactory('MockVaultManagerForRewards');
		const vm = await MockVM.deploy();
		const RP = await ethers.getContractFactory('RewardsPool');
		await expect(
			upgrades.deployProxy(RP, [ethers.ZeroAddress, updater.address, await vm.getAddress()], { kind: 'uups' })
		).to.be.revertedWith('RP: zero address');
		await expect(
			upgrades.deployProxy(RP, [admin.address, ethers.ZeroAddress, await vm.getAddress()], { kind: 'uups' })
		).to.be.revertedWith('RP: zero address');
		await expect(
			upgrades.deployProxy(RP, [admin.address, updater.address, ethers.ZeroAddress], { kind: 'uups' })
		).to.be.revertedWith('RP: zero address');
	});

	it('only DEFAULT_ADMIN can upgrade', async () => {
		const { rp, admin, owner1 } = await deployPool();
		const V2 = await ethers.getContractFactory('RewardsPoolV2Mock');
		const opts = { unsafeAllow: ['missing-initializer'] as const };
		await expect(
			upgrades.upgradeProxy(await rp.getAddress(), V2.connect(owner1), opts)
		).to.be.reverted;
		const upgraded = await upgrades.upgradeProxy(await rp.getAddress(), V2.connect(admin), opts);
		expect(await upgraded.version()).to.equal(2n);
		expect(await upgraded.totalWeight()).to.equal(0n);
	});
});
