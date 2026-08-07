import { ethers } from 'hardhat';
import { expect } from 'chai';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import { deploySystem } from './VaultManager.spec';

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const E = (n: string) => ethers.parseEther(n);

// 80/20 split + 3-level affiliate (MLM). Commissions paid in the purchase stablecoin; a level earns
// only if it holds a vault (skin-in-the-game); unqualified/empty legs roll into the DAO bucket.
describe('MLM — 80/20 split + 3-level affiliate', () => {
	async function setup() {
		const sys = await deploySystem(); // initializeV2 + initializeV3(dao) already run
		const { vm, admin, operator, dai, wklc, router, dev, amb, builders } = sys;
		await vm.connect(admin).setFeeRecipients(dev.address, amb.address, builders.address); // sets devRecipient
		await vm.connect(admin).setTier(0, 100, 1500, 'ipfs://light', true);
		await vm.connect(admin).setTierCap(0, 25000);
		await vm.connect(admin).setStable(dai.target, true, 18, ethers.Wallet.createRandom().address, 10000);
		await vm.connect(operator).setMaxTotalWeight(10n ** 12n);
		await vm.connect(operator).setReferencePrice(dai.target, E('500'));
		await vm.connect(operator).setSlippageBps(300);
		await (router as any).setRate(dai.target, wklc.target, E('500'));
		await (wklc as any).mint(router.target, E('1000000'));
		return sys;
	}

	// Buy a $100 vault as `who`, optionally referred by `ref`.
	async function buy(sys: any, who: any, ref?: any) {
		const { vm, dai } = sys;
		await (dai as any).mint(who.address, E('100'));
		await dai.connect(who).approve(vm.target, E('100'));
		return ref
			? vm.connect(who)['purchase(uint8,address,uint256,address)'](0, dai.target, FUTURE, ref.address)
			: vm.connect(who)['purchase(uint8,address,uint256)'](0, dai.target, FUTURE);
	}

	it('routes the 80/20 split across a qualifying 3-level chain', async () => {
		const sys = await setup();
		const { vm, dai, alice: a, bob: b, dev, dao } = sys;
		const [, , , , , , , , , c, d] = await ethers.getSigners();

		// Build the chain A <- B <- C <- D so each upline holds a vault (passes the gate).
		await buy(sys, a);          // A organic
		await buy(sys, b, a);       // B referred by A
		await buy(sys, c, b);       // C referred by B
		const tx = await buy(sys, d, c); // D referred by C

		// D's buy pays C/B/A as N1/N2/N3 (all hold vaults). $100 tier:
		// N1 6% = $6, N2 2.5% = $2.5, N3 1.5% = $1.5, dev 2% = $2, DAO 8% = $8, POL 80% = $80.
		await expect(tx).to.emit(vm, 'FeesRouted').withArgs(
			d.address, dai.target, c.address, b.address, a.address,
			E('6'), E('2.5'), E('1.5'), E('2'), E('8'),
		);
		await expect(tx).to.emit(vm, 'PolDeployed').withArgs(dai.target, E('40'), anyValue, anyValue);
		expect(await dai.balanceOf(dev.address)).to.be.gt(0n); // dev accrued across the chain
		expect(await dai.balanceOf(dao.address)).to.be.gt(0n);
	});

	it('sponsor is sticky — a later buy with a different referrer cannot change it', async () => {
		const sys = await setup();
		const { vm, alice: a, bob: b } = sys;
		const [, , , , , , , , , c] = await ethers.getSigners();
		await buy(sys, a);
		await buy(sys, b, a);            // sponsorOf[b] = A
		expect(await vm.sponsorOf(b.address)).to.equal(a.address);
		await buy(sys, b, c);            // attempt to re-point to C
		expect(await vm.sponsorOf(b.address)).to.equal(a.address); // unchanged
	});

	it('unqualified sponsor (holds no vault) → its leg rolls to the DAO', async () => {
		const sys = await setup();
		const { vm, dai, alice: a, bob: b, dao } = sys;
		// A never buys → holds no vault. B buys referred by A → A is N1 but fails the gate.
		const daoBefore = await dai.balanceOf(dao.address);
		const tx = await buy(sys, b, a);
		// N1 (A, $6) rolls to DAO; DAO = 8% base + 6% rolled + 2.5% + 1.5% (N2/N3 empty) = 18% = $18.
		await expect(tx).to.emit(vm, 'FeesRouted').withArgs(
			b.address, dai.target, a.address, ethers.ZeroAddress, ethers.ZeroAddress,
			E('6'), E('2.5'), E('1.5'), E('2'), E('18'),
		);
		expect(await dai.balanceOf(dao.address) - daoBefore).to.equal(E('18'));
		expect(await dai.balanceOf(a.address)).to.equal(0n); // A earned nothing (no vault)
	});

	it('organic buy (no sponsor) routes all affiliate bps to the DAO and never reverts', async () => {
		const sys = await setup();
		const { vm, dai, alice: a, dao } = sys;
		const daoBefore = await dai.balanceOf(dao.address);
		await expect(buy(sys, a)).to.emit(vm, 'Purchased');
		// no sponsor → N1+N2+N3 (10%) all roll to DAO → DAO = 18%.
		expect(await dai.balanceOf(dao.address) - daoBefore).to.equal(E('18'));
	});

	it('self-referral is ignored (referrer == buyer → no sponsor set)', async () => {
		const sys = await setup();
		const { vm, alice: a } = sys;
		await buy(sys, a, a); // refer self
		expect(await vm.sponsorOf(a.address)).to.equal(ethers.ZeroAddress);
	});

	it('setFeeSplit enforces the 80% POL floor and is admin-gated', async () => {
		const sys = await setup();
		const { vm, admin, alice } = sys;
		await expect(vm.connect(admin).setFeeSplit(700, 300, 200, 300, 600)) // 2100 > 2000
			.to.be.revertedWith('VM: POL floor');
		await vm.connect(admin).setFeeSplit(600, 250, 150, 200, 800); // exactly 2000 ok
		expect(await vm.n1Bps()).to.equal(600);
		await expect(vm.connect(alice).setFeeSplit(100, 100, 100, 100, 100)).to.be.reverted; // not admin
	});
});
