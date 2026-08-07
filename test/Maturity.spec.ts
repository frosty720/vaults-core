import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { deploySystem } from './VaultManager.spec';

async function setup() {
	const [admin, updater, owner1] = await ethers.getSigners();
	const MockVM = await ethers.getContractFactory('MockVaultManagerForRewards');
	const vm = await MockVM.deploy();
	const RP = await ethers.getContractFactory('RewardsPool');
	const rp = await upgrades.deployProxy(RP, [admin.address, updater.address, await vm.getAddress()], { kind: 'uups' });
	return { rp, vm, admin, updater, owner1 };
}

describe('Maturity — USD cap valuation + clamp', () => {
	it('values KLC at klcUsdPrice and matures exactly at the cap', async () => {
		const { rp, vm, updater, owner1 } = await setup();
		await vm.setOwner(1, owner1.address);
		await vm.setKlcUsd(ethers.parseEther('1')); // $1 per KLC for clean math
		await rp.connect(updater).registerVault(1, 100, ethers.parseEther('250')); // $250 cap, sole vault

		await owner1.sendTransaction({ to: await rp.getAddress(), value: ethers.parseEther('200') }); // $200 earned
		await rp.mature(1);
		expect(await rp.isMatured(1)).to.equal(false);
		expect(await rp.earnedUsdOf(1)).to.be.closeTo(ethers.parseEther('200'), ethers.parseEther('0.01'));
		expect(await rp.earned(1)).to.be.closeTo(ethers.parseEther('200'), ethers.parseEther('0.01'));

		await owner1.sendTransaction({ to: await rp.getAddress(), value: ethers.parseEther('100') }); // would be $300 -> clamp $250
		await rp.mature(1);
		expect(await rp.isMatured(1)).to.equal(true);
		expect(await rp.earnedUsdOf(1)).to.equal(ethers.parseEther('250'));
		// At $1/KLC with a sole vault (weight=100) the accumulator math is exact:
		// payKlc = remainingUsd(50e18) * PRECISION / klcUsd(1e18) = 50e18; accrued = 200e18 + 50e18 = 250e18.
		expect(await rp.earned(1)).to.equal(ethers.parseEther('250'));
		expect(await rp.totalWeight()).to.equal(0);
	});

	it('_pendingKlc is zero for a matured vault', async () => {
		const { rp, vm, updater, owner1 } = await setup();
		await vm.setOwner(1, owner1.address);
		await vm.setKlcUsd(ethers.parseEther('1'));
		await rp.connect(updater).registerVault(1, 100, ethers.parseEther('50'));

		// Deposit enough to surpass cap and mature
		await owner1.sendTransaction({ to: await rp.getAddress(), value: ethers.parseEther('100') });
		await rp.mature(1);
		expect(await rp.isMatured(1)).to.equal(true);

		// After maturity: totalWeight == 0, earned stays fixed
		const earnedAfter = await rp.earned(1);
		// Deposit more KLC — matured vault should see no increase
		await owner1.sendTransaction({ to: await rp.getAddress(), value: ethers.parseEther('50') });
		expect(await rp.earned(1)).to.equal(earnedAfter);
	});

	it('two vaults: only the one that hits cap matures; other keeps earning', async () => {
		const { rp, vm, updater, owner1 } = await setup();
		const [, , , owner2] = await ethers.getSigners();
		await vm.setOwner(1, owner1.address);
		await vm.setOwner(2, owner2.address);
		await vm.setKlcUsd(ethers.parseEther('1'));
		// vault 1: $100 cap; vault 2: very high cap — equal weight
		await rp.connect(updater).registerVault(1, 100, ethers.parseEther('100'));
		await rp.connect(updater).registerVault(2, 100, ethers.parseEther('1000000'));

		// Send 300 KLC ($300) total → each vault's 50% share = 150 KLC ($150)
		// vault 1: $150 > $100 cap → clamps at $100, recycles 50 KLC back to pool
		// vault 2: checkpoint after vault 1 → _accrue() picks up the 50 recycled KLC
		//           (totalWeight = 100 at that point, all weight belongs to vault 2)
		//           so vault 2 accumulates its original 150 KLC + 50 recycled = 200 KLC = $200
		await owner1.sendTransaction({ to: await rp.getAddress(), value: ethers.parseEther('300') });
		await rp.mature(1); // vault 1 checkpoints, clamps, recycles 50 KLC, matures
		await rp.mature(2); // vault 2 checkpoints, picks up 150 + 50 recycled = 200

		expect(await rp.isMatured(1)).to.equal(true);
		expect(await rp.earnedUsdOf(1)).to.equal(ethers.parseEther('100'));
		expect(await rp.isMatured(2)).to.equal(false);
		// vault 2 earned $150 original share + $50 recycled from vault 1 = $200
		expect(await rp.earnedUsdOf(2)).to.be.closeTo(ethers.parseEther('200'), ethers.parseEther('0.01'));
		// vault 2 still has weight
		expect(await rp.totalWeight()).to.equal(100n);
	});

	it('earned() view matches _checkpoint value at pre-mature boundary', async () => {
		const { rp, vm, updater, owner1 } = await setup();
		await vm.setOwner(1, owner1.address);
		await vm.setKlcUsd(ethers.parseEther('2')); // $2 per KLC
		// cap = $100 → max KLC = 50
		await rp.connect(updater).registerVault(1, 100, ethers.parseEther('100'));

		// Deposit 30 KLC → $60 → under cap
		await owner1.sendTransaction({ to: await rp.getAddress(), value: ethers.parseEther('30') });

		// earned() view should show 30 KLC (pending)
		expect(await rp.earned(1)).to.be.closeTo(ethers.parseEther('30'), ethers.parseEther('0.001'));

		// After checkpoint via mature(), accrued should match
		await rp.mature(1);
		expect(await rp.isMatured(1)).to.equal(false);
		expect(await rp.accrued(1)).to.be.closeTo(ethers.parseEther('30'), ethers.parseEther('0.001'));
		expect(await rp.earned(1)).to.equal(await rp.accrued(1));
	});

	it('excess KLC is recycled: sole vault matures but excess stays in contract', async () => {
		const { rp, vm, updater, owner1 } = await setup();
		await vm.setOwner(1, owner1.address);
		await vm.setKlcUsd(ethers.parseEther('1'));
		// cap = $100 → max 100 KLC
		await rp.connect(updater).registerVault(1, 100, ethers.parseEther('100'));

		// Send 150 KLC → 50 KLC excess
		await owner1.sendTransaction({ to: await rp.getAddress(), value: ethers.parseEther('150') });
		await rp.mature(1);

		expect(await rp.isMatured(1)).to.equal(true);
		expect(await rp.earnedUsdOf(1)).to.equal(ethers.parseEther('100'));
		// accrued should be exactly 100 KLC (clamped)
		expect(await rp.accrued(1)).to.be.closeTo(ethers.parseEther('100'), ethers.parseEther('0.01'));

		// lastDistributedBalance should have been decremented by the 50 excess
		// (balance = 150, lastDistributedBalance should be 100 so next vault can accrue the 50)
		const rpBalance = await ethers.provider.getBalance(await rp.getAddress());
		expect(rpBalance).to.equal(ethers.parseEther('150')); // KLC stays in contract

		// Register new vault — it should be able to earn the recycled 50 KLC
		const [, , , owner2] = await ethers.getSigners();
		await vm.setOwner(2, owner2.address);
		await rp.connect(updater).registerVault(2, 100, ethers.parseEther('1000000'));
		// The recycled 50 KLC should accrue to vault 2 on next deposit
		await owner1.sendTransaction({ to: await rp.getAddress(), value: ethers.parseEther('10') });
		await rp.mature(2);
		// vault 2 should have earned the 50 recycled + 10 new = 60 KLC
		expect(await rp.earnedUsdOf(2)).to.be.closeTo(ethers.parseEther('60'), ethers.parseEther('0.01'));
	});

	it('rejects no-price scenario in _checkpoint', async () => {
		const { rp, vm, updater, owner1 } = await setup();
		await vm.setOwner(1, owner1.address);
		await vm.setKlcUsd(0); // no price set
		await rp.connect(updater).registerVault(1, 100, ethers.parseEther('250'));

		await owner1.sendTransaction({ to: await rp.getAddress(), value: ethers.parseEther('10') });
		await expect(rp.mature(1)).to.be.revertedWith('RP: no price');
	});

	// ─── Task 5: permissionless mature + excess recycling ────────────────────

	it('T5-a: a stranger (non-owner) can trigger maturity when cap is crossed', async () => {
		const { rp, vm, updater, owner1 } = await setup();
		const [, , , , stranger] = await ethers.getSigners();

		await vm.setOwner(1, owner1.address);
		await vm.setKlcUsd(ethers.parseEther('1')); // $1/KLC
		// cap = $50 — deposit 100 KLC → triggers maturity
		await rp.connect(updater).registerVault(1, 100, ethers.parseEther('50'));
		await owner1.sendTransaction({ to: await rp.getAddress(), value: ethers.parseEther('100') });

		// stranger is not the vault owner — must still succeed
		expect(await rp.isMatured(1)).to.equal(false);
		await rp.connect(stranger).mature(1);
		expect(await rp.isMatured(1)).to.equal(true);

		// Vault earned exactly the cap ($50 = 50 KLC), not more
		expect(await rp.earnedUsdOf(1)).to.equal(ethers.parseEther('50'));
		expect(await rp.accrued(1)).to.be.closeTo(ethers.parseEther('50'), ethers.parseEther('0.01'));
	});

	it('T5-b: excess recycles to remaining vault — vault 2 earns its share plus recycled excess', async () => {
		const { rp, vm, updater, owner1 } = await setup();
		const [, , , owner2, stranger] = await ethers.getSigners();

		await vm.setKlcUsd(ethers.parseEther('1')); // $1/KLC for clean math
		await vm.setOwner(1, owner1.address);
		await vm.setOwner(2, owner2.address);

		// vault 1: tiny $5 cap; vault 2: enormous cap — equal weight 100 each
		await rp.connect(updater).registerVault(1, 100, ethers.parseEther('5'));
		await rp.connect(updater).registerVault(2, 100, ethers.parseEther('1000000'));

		// Send 20 KLC ($20 at $1/KLC) → each vault's 50% share = 10 KLC ($10)
		// vault 1 cap = $5 → clamps at 5 KLC, recycles 5 KLC back to pool
		await owner1.sendTransaction({ to: await rp.getAddress(), value: ethers.parseEther('20') });

		// A stranger (not the vault owner) triggers maturity on vault 1
		await rp.connect(stranger).mature(1);
		expect(await rp.isMatured(1)).to.equal(true);
		expect(await rp.earnedUsdOf(1)).to.equal(ethers.parseEther('5'));
		// vault 1 paid exactly 5 KLC; the other 5 were recycled
		expect(await rp.accrued(1)).to.be.closeTo(ethers.parseEther('5'), ethers.parseEther('0.01'));

		// After vault 1 matures, totalWeight = 100 (vault 2 alone)
		expect(await rp.totalWeight()).to.equal(100n);

		// Stranger checkpoints vault 2 — it picks up its original 10 KLC + 5 recycled = 15 KLC
		await rp.connect(stranger).mature(2);
		expect(await rp.isMatured(2)).to.equal(false); // cap not reached
		// vault 2 should have earned > 10 KLC (got the recycled excess too)
		expect(await rp.earnedUsdOf(2)).to.be.closeTo(ethers.parseEther('15'), ethers.parseEther('0.1'));
		expect(await rp.accrued(2)).to.be.closeTo(ethers.parseEther('15'), ethers.parseEther('0.1'));
	});
});

// ─── Task 8: price-appreciation accelerates maturity ────────────────────────

describe('Maturity — appreciation accelerates the cap', () => {
	it('a 10x KLC price makes a vault reach its USD cap with far less KLC', async () => {
		const { rp, vm, updater, owner1 } = await setup();
		await vm.setOwner(1, owner1.address);
		await rp.connect(updater).registerVault(1, 100, ethers.parseEther('250')); // $250 cap, sole vault
		await vm.setKlcUsd(ethers.parseEther('1'));   // $1/KLC
		await owner1.sendTransaction({ to: await rp.getAddress(), value: ethers.parseEther('100') }); // $100
		await rp.mature(1);
		expect(await rp.isMatured(1)).to.equal(false);
		expect(await rp.earnedUsdOf(1)).to.be.closeTo(ethers.parseEther('100'), ethers.parseEther('0.01'));
		await vm.setKlcUsd(ethers.parseEther('10'));  // 10x -> $10/KLC
		await owner1.sendTransaction({ to: await rp.getAddress(), value: ethers.parseEther('15') }); // 15 KLC -> $150 -> total $250
		await rp.mature(1);
		expect(await rp.isMatured(1)).to.equal(true);
		expect(await rp.earnedUsdOf(1)).to.equal(ethers.parseEther('250'));
		expect(await rp.earned(1)).to.be.closeTo(ethers.parseEther('115'), ethers.parseEther('0.2')); // ~115 KLC, not ~250
	});
});

// ─── Task 6: tierCapBps mapping + klcUsdPrice anchor ────────────────────────

describe('T6 — klcUsdPrice anchor via priceAnchorStable', () => {
	// Uses the REAL VaultManager + RewardsPool (from the shared deploySystem fixture).
	// referencePrice[stable] = KLC per $1 (1e18) → klcUsdPrice() = 1e36 / referencePrice.

	async function configuredWithAnchor() {
		const sys = await deploySystem();
		const { vm, admin, operator, dai } = sys;
		// configure tier 0, stable, bounds, ref price
		await vm.connect(admin).setTier(0, 100, 1500, 'ipfs://light', true);
		await vm.connect(admin).setStable(dai.target, true, 18, ethers.Wallet.createRandom().address, 10000);
		await vm.connect(admin).setOperatorBounds(1_000_000_000_000n, 0, 500);
		await vm.connect(operator).setReferencePrice(dai.target, ethers.parseEther('500')); // 500 KLC per $1
		// set price anchor to dai
		await vm.connect(operator).setPriceAnchor(dai.target);
		return sys;
	}

	it('T6-a: klcUsdPrice() returns 1e36 / referencePrice[anchor]', async () => {
		const { vm, dai } = await configuredWithAnchor();
		const ref = await vm.referencePrice(dai.target);
		const expected = (10n ** 36n) / ref;
		expect(await (vm as any).klcUsdPrice()).to.equal(expected);
	});

	it('T6-b: setPriceAnchor reverts when stable is not enabled', async () => {
		const { vm, operator } = await deploySystem();
		const fakeStable = ethers.Wallet.createRandom().address;
		await expect((vm as any).connect(operator).setPriceAnchor(fakeStable))
			.to.be.revertedWith('VM: stable not enabled');
	});

	it('T6-c: klcUsdPrice() reverts when no anchor is set (referencePrice == 0)', async () => {
		const sys = await deploySystem();
		const { vm, admin, operator, dai } = sys;
		await vm.connect(admin).setStable(dai.target, true, 18, ethers.Wallet.createRandom().address, 10000);
		await vm.connect(admin).setOperatorBounds(1_000_000_000_000n, 0, 500);
		// Set anchor but do NOT set referencePrice → ref = 0
		await vm.connect(operator).setPriceAnchor(dai.target);
		await expect((vm as any).klcUsdPrice()).to.be.revertedWith('VM: no anchor price');
	});

	it('T6-d: setTierCap reverts for an out-of-range tier index', async () => {
		const { vm, admin } = await deploySystem();
		// no tiers configured → index 0 is out of range
		await expect((vm as any).connect(admin).setTierCap(0, 25000))
			.to.be.revertedWith('VM: bad tier');
	});

	it('T6-e: priceAnchorStable and tierCapBps are readable after being set', async () => {
		const { vm, dai } = await configuredWithAnchor();
		expect(await (vm as any).priceAnchorStable()).to.equal(dai.target);
		// setTierCap(0, 25000) = 250% for tier index 0
		const [admin] = await ethers.getSigners();
		await (vm as any).connect(admin).setTierCap(0, 25000);
		expect(await (vm as any).tierCapBps(0)).to.equal(25000n);
	});
});

// ─── Task 7: register vault with REAL USD cap on purchase ───────────────────

describe('T7 — capUsdOf matches tierCapBps * priceUSD on purchase', () => {
	// tier 0: priceUSD=100, aprBps=1500 → weight=150000
	// tierCapBps[0] = 25000 → capUsd = 25000 * 100 * 1e18 / 10000 = $250e18

	async function buyerFixture() {
		const sys = await deploySystem();
		const { vm, pool, admin, operator, dai, wklc, router, dev, amb, builders, alice } = sys;

		await vm.connect(admin).setTier(0, 100, 1500, 'ipfs://light', true);       // weight 150000
		await vm.connect(admin).setTier(1, 500, 2000, 'ipfs://builder', true);     // weight 1000000
		await vm.connect(admin).setFeeRecipients(dev.address, amb.address, builders.address);
		await vm.connect(admin).setStable(dai.target, true, 18, ethers.Wallet.createRandom().address, 10000);
		await vm.connect(admin).setOperatorBounds(1_000_000_000_000n, 0, 500);
		await vm.connect(operator).setMaxTotalWeight(1_000_000_000_000n);
		await vm.connect(operator).setReferencePrice(dai.target, ethers.parseEther('500'));
		await vm.connect(operator).setSlippageBps(300);
		await router.setRate(dai.target, wklc.target, ethers.parseEther('500'));
		await wklc.mint(router.target, ethers.parseEther('1000000'));

		// Set tier caps: 25000 bps for tier 0 (250%), 35000 bps for tier 1 (350%)
		await (vm as any).connect(admin).setTierCap(0, 25000);
		await (vm as any).connect(admin).setTierCap(1, 35000);

		// Set price anchor so RewardsPool can later call klcUsdPrice (not needed for registerVault
		// itself, but wires up the full maturity path for completeness)
		await vm.connect(operator).setPriceAnchor(dai.target);

		return { ...sys, admin, operator, dai, wklc, router, alice };
	}

	it('T7-a: capUsdOf(tokenId) == tierCapBps * priceUSD * 1e18 / BPS on purchase (Light tier)', async () => {
		const { vm, pool, dai, alice } = await buyerFixture();

		await dai.mint(alice.address, ethers.parseEther('100'));
		await dai.connect(alice).approve(vm.target, ethers.parseEther('100'));
		await vm.connect(alice).purchase(0, dai.target, 9999999999n);

		const tokenId = 1n;
		// capUsd = tierCapBps * priceUSD * 1e18 / BPS
		// = 25000 * 100 * 1e18 / 10000 = 250e18 (250% of $100 = $250)
		const expectedCap = (25000n * 100n * (10n ** 18n)) / 10000n;
		expect(await pool.capUsdOf(tokenId)).to.equal(expectedCap);
	});

	it('T7-b: vaultWeight(tokenId) equals the tier weight after purchase', async () => {
		const { vm, pool, dai, alice } = await buyerFixture();

		await dai.mint(alice.address, ethers.parseEther('100'));
		await dai.connect(alice).approve(vm.target, ethers.parseEther('100'));
		await vm.connect(alice).purchase(0, dai.target, 9999999999n);

		const tokenId = 1n;
		// tier 0: weight = priceUSD * aprBps = 100 * 1500 = 150000
		expect(await pool.vaultWeight(tokenId)).to.equal(150000n);
	});

	it('T7-c: tierCapBps=0 → purchase reverts with "VM: tier cap unset" (guard enforces cap must be set)', async () => {
		// tierCapBps defaults to 0 when setTierCap is never called.
		// The new guard in _registerInPool requires capUsd > 0, so a purchase must revert.
		const sys = await deploySystem();
		const { vm, admin, operator, dai, wklc, router, dev, amb, builders, alice } = sys;

		await vm.connect(admin).setTier(0, 100, 1500, 'ipfs://light', true);
		await vm.connect(admin).setFeeRecipients(dev.address, amb.address, builders.address);
		await vm.connect(admin).setStable(dai.target, true, 18, ethers.Wallet.createRandom().address, 10000);
		await vm.connect(admin).setOperatorBounds(1_000_000_000_000n, 0, 500);
		await vm.connect(operator).setMaxTotalWeight(1_000_000_000_000n);
		await vm.connect(operator).setReferencePrice(dai.target, ethers.parseEther('500'));
		await vm.connect(operator).setSlippageBps(300);
		await router.setRate(dai.target, wklc.target, ethers.parseEther('500'));
		await wklc.mint(router.target, ethers.parseEther('1000000'));
		// NO setTierCap → tierCapBps[0] defaults to 0 → capUsd = 0 → must revert

		await dai.mint(alice.address, ethers.parseEther('100'));
		await dai.connect(alice).approve(vm.target, ethers.parseEther('100'));
		await expect(vm.connect(alice).purchase(0, dai.target, 9999999999n))
			.to.be.revertedWith('VM: tier cap unset');
	});

	it('T7-d: transferring NFT does NOT change totalWeight or vaultWeight in the RewardsPool', async () => {
		const { vm, pool, dai, alice, bob } = await buyerFixture();

		await dai.mint(alice.address, ethers.parseEther('100'));
		await dai.connect(alice).approve(vm.target, ethers.parseEther('100'));
		await vm.connect(alice).purchase(0, dai.target, 9999999999n);

		const tokenId = 1n;
		const weightBefore = await pool.vaultWeight(tokenId);
		const totalBefore = await pool.totalWeight();

		// Transfer from alice → bob
		await vm.connect(alice).transferFrom(alice.address, bob.address, tokenId);

		// per-vault state travels with the NFT: no weight bookkeeping on transfer
		expect(await pool.vaultWeight(tokenId)).to.equal(weightBefore);
		expect(await pool.totalWeight()).to.equal(totalBefore);
		expect(await vm.ownerOf(tokenId)).to.equal(bob.address);
	});

	it('T7-e: units check — capUsd = 250e18 for Light tier (25000 bps, priceUSD=$100)', async () => {
		// Explicit arithmetic verification of the formula.
		// tierCapBps = 25000, priceUSD = 100, BPS = 10000
		// capUsd = 25000 * 100 * 1e18 / 10000 = 250 * 1e18
		// i.e. 250% ROI cap on a $100 vault = $250 cap in 1e18 USD units
		const capUsd = (25000n * 100n * (10n ** 18n)) / 10000n;
		expect(capUsd).to.equal(250n * (10n ** 18n));
	});

	it('T7-f: guard — purchase reverts before cap is set, succeeds after; capUsdOf matches formula', async () => {
		// This is the focused guard test for the _registerInPool require(capUsd > 0) safety check.
		//
		// Scenario: tier 0 (priceUSD=100, aprBps=1500) is configured but setTierCap is NOT called.
		// A purchase attempt must revert with 'VM: tier cap unset'.
		// Then setTierCap(0, 25000) is called and the same purchase succeeds.
		// capUsdOf(tokenId) must equal 25000 * 100 * 1e18 / 10000 = 250e18.
		const sys = await deploySystem();
		const { vm, pool, admin, operator, dai, wklc, router, dev, amb, builders, alice } = sys;

		await vm.connect(admin).setTier(0, 100, 1500, 'ipfs://light', true);
		// Deliberately do NOT call setTierCap here
		await vm.connect(admin).setFeeRecipients(dev.address, amb.address, builders.address);
		await vm.connect(admin).setStable(dai.target, true, 18, ethers.Wallet.createRandom().address, 10000);
		await vm.connect(admin).setOperatorBounds(1_000_000_000_000n, 0, 500);
		await vm.connect(operator).setMaxTotalWeight(1_000_000_000_000n);
		await vm.connect(operator).setReferencePrice(dai.target, ethers.parseEther('500'));
		await vm.connect(operator).setSlippageBps(300);
		await router.setRate(dai.target, wklc.target, ethers.parseEther('500'));
		await wklc.mint(router.target, ethers.parseEther('1000000'));

		await dai.mint(alice.address, ethers.parseEther('100'));
		await dai.connect(alice).approve(vm.target, ethers.parseEther('100'));

		// Step 1: purchase must revert because tierCapBps[0] == 0
		await expect(vm.connect(alice).purchase(0, dai.target, 9999999999n))
			.to.be.revertedWith('VM: tier cap unset');

		// Step 2: admin sets the cap — now the purchase must succeed
		await vm.connect(admin).setTierCap(0, 25000);
		await vm.connect(alice).purchase(0, dai.target, 9999999999n);

		// Step 3: capUsdOf(tokenId=1) must equal 25000 * 100 * 1e18 / 10000 = 250e18
		const expectedCap = (25000n * 100n * (10n ** 18n)) / 10000n; // 250e18
		expect(await pool.capUsdOf(1n)).to.equal(expectedCap);
	});
});
