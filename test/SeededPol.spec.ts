import { ethers, upgrades } from 'hardhat';
import { expect } from 'chai';

const FUTURE = Math.floor(Date.now() / 1000) + 3600;

// Seeded-bootstrap POL: each purchase market-buys a depth-bounded slice (buy pressure) and
// seeds the rest of the LP from the protocol WKLC reserve. No buffer, no drip. See
// docs/superpowers/specs/2026-06-16-pol-seeded-bootstrap-design.md.
describe('SeededPol — market-buy + reserve seed', () => {
	// poolDai = stable seeded into the (fake) v3Pool address → drives the market-buy size.
	// reserveWklc = WKLC minted to the VaultManager → the protocol seed reserve.
	async function deploy(poolDai: bigint, reserveWklc: bigint) {
		const [admin, operator, treasury, dev, amb, builders, buyer] = await ethers.getSigners();
		const ERC20 = await ethers.getContractFactory('MockERC20');
		const wklc = await (await ethers.getContractFactory('MockWKLC')).deploy();
		const dai = await ERC20.deploy('DAI', 'DAI', 18);
		const router = await (await ethers.getContractFactory('MockSwapRouter')).deploy();
		const npm = await (await ethers.getContractFactory('MockPositionManager')).deploy();

		const Pool = await ethers.getContractFactory('RewardsPool');
		const pool = await upgrades.deployProxy(Pool, [admin.address, admin.address, admin.address], { kind: 'uups' });

		const polLib = await (await ethers.getContractFactory('PolLib')).deploy();
		const VM = await ethers.getContractFactory('VaultManager', { libraries: { PolLib: polLib.target } });
		const vm = await upgrades.deployProxy(VM, [
			admin.address, operator.address, pool.target, treasury.address,
			wklc.target, router.target, npm.target,
		], { kind: 'uups', unsafeAllow: ['external-library-linking'] });

		await pool.connect(admin).grantRole(await pool.WEIGHT_UPDATER_ROLE(), vm.target);
		await vm.connect(admin).setOperatorBounds(1000000000000n * 10n ** 18n, 4000, 2000);
		await (vm as any).connect(admin).initializeV2();
		await (vm as any).connect(admin).initializeV3(treasury.address); // 80/20 + MLM defaults

		await vm.connect(admin).setTier(0, 100, 1500, 'ipfs://light', true);
		await vm.connect(admin).setTierCap(0, 25000);
		await vm.connect(admin).setTier(1, 1000, 2000, 'ipfs://validator', true);
		await vm.connect(admin).setTierCap(1, 35000);
		await vm.connect(admin).setFeeRecipients(dev.address, amb.address, builders.address);

		const v3Pool = ethers.Wallet.createRandom().address;
		await vm.connect(admin).setStable(dai.target, true, 18, v3Pool, 3000);
		await vm.connect(operator).setMaxTotalWeight(1000000000000n * 10n ** 18n);
		await vm.connect(operator).setReferencePrice(dai.target, ethers.parseEther('500')); // 1 DAI = 500 WKLC
		await (router as any).setRate(dai.target, wklc.target, ethers.parseEther('500'));
		await (wklc as any).mint(router.target, ethers.parseEther('1000000000')); // router WKLC supply

		// Seed the fake pool's stable depth (drives the market-buy size).
		if (poolDai > 0n) await (dai as any).mint(v3Pool, poolDai);
		// Fund the protocol WKLC reserve.
		if (reserveWklc > 0n) await (wklc as any).mint(vm.target, reserveWklc);

		return { vm, dai, wklc, router, npm, pool, admin, operator, treasury, buyer, v3Pool };
	}

	async function buy(vm: any, dai: any, buyer: any, tier: number, priceDai: bigint) {
		await (dai as any).mint(buyer.address, priceDai);
		await dai.connect(buyer).approve(vm.target, priceDai);
		return vm.connect(buyer)['purchase(uint8,address,uint256)'](tier, dai.target, FUTURE);
	}

	it('initializeV2 sets buy params; setBuyParams is operator-gated', async () => {
		const { vm, operator, buyer } = await deploy(2000n * 10n ** 18n, 0n);
		expect(await vm.buyImpactBps()).to.equal(300);
		expect(await vm.minBuyUsd()).to.equal(100);

		await vm.connect(operator).setBuyParams(500, 250);
		expect(await vm.buyImpactBps()).to.equal(500);
		expect(await vm.minBuyUsd()).to.equal(250);

		await expect(vm.connect(buyer).setBuyParams(100, 100)).to.be.reverted; // not operator
		await expect(vm.connect(operator).setBuyParams(10001, 100)).to.be.revertedWith('VM: bps too high');
	});

	it('fundReserve wraps native KLC into the WKLC reserve', async () => {
		const { vm, operator } = await deploy(2000n * 10n ** 18n, 0n);
		expect(await vm.reserveWklc()).to.equal(0n);
		await vm.connect(operator).fundReserve({ value: ethers.parseEther('1234') });
		expect(await vm.reserveWklc()).to.equal(ethers.parseEther('1234'));
		await expect(vm.connect(operator).fundReserve({ value: 0 })).to.be.revertedWith('VM: zero value');
	});

	it('thin pool + funded reserve: a $1000 buy deploys ALL POL in-tx, drawing the reserve', async () => {
		// pool $2000 → market-buy floors to $100; reserve funded generously.
		const reserve = ethers.parseEther('1000000'); // 1e6 WKLC
		const { vm, dai, treasury, buyer, npm } = await deploy(2000n * 10n ** 18n, reserve);

		const reserveBefore = await vm.reserveWklc();
		const tx = await buy(vm, dai, buyer, 1, ethers.parseEther('1000'));

		// 80% POL → P = $800. market-buy slice = $100 (floor); swap rate 500 → 50,000 WKLC out
		await expect(tx).to.emit(vm, 'PolDeployed').withArgs(dai.target, ethers.parseEther('100'), ethers.parseEther('50000'), 1);

		// reserve draw d = stableToWklc(P - 2a) = (800 - 200) * 500 = 300,000 WKLC
		const drawn = reserveBefore - (await vm.reserveWklc());
		expect(drawn).to.equal(ethers.parseEther('300000'));

		// no stranded stable in the VaultManager — full POL deployed, none buffered
		expect(await dai.balanceOf(vm.target)).to.equal(0n);

		// LP position minted to the treasury; stable side = P - a = $810
		expect(await npm.lastRecipient()).to.equal(treasury.address);
	});

	it('deep pool: self-terminates — a == P/2 and the reserve is NOT drawn (pure market-buy)', async () => {
		// 80% POL → P = $800. pool $100k → 3% = $3000, capped at P/2 = $400 → d = (800 - 800) = 0
		const reserve = ethers.parseEther('1000000');
		const { vm, dai, buyer } = await deploy(100000n * 10n ** 18n, reserve);

		const reserveBefore = await vm.reserveWklc();
		const tx = await buy(vm, dai, buyer, 1, ethers.parseEther('1000'));
		await expect(tx).to.emit(vm, 'PolDeployed').withArgs(dai.target, ethers.parseEther('400'), ethers.parseEther('200000'), 1);

		// reserve untouched — the buy funded its own balanced LP entirely from the open market
		expect(await vm.reserveWklc()).to.equal(reserveBefore);
		expect(await dai.balanceOf(vm.target)).to.equal(0n);
	});

	it('degraded mode: empty reserve still completes the purchase (never reverts)', async () => {
		const { vm, dai, buyer } = await deploy(2000n * 10n ** 18n, 0n); // reserve = 0
		await expect(buy(vm, dai, buyer, 1, ethers.parseEther('1000'))).to.emit(vm, 'Purchased');
		// vault NFT minted, no revert despite no reserve to seed with
		expect(await vm.ownerOf(1)).to.equal(buyer.address);
	});

	it('rescueERC20 cannot drain the WKLC reserve', async () => {
		const { vm, wklc, dai, admin, treasury } = await deploy(2000n * 10n ** 18n, ethers.parseEther('1000'));
		await expect(
			vm.connect(admin).rescueERC20(wklc.target, treasury.address, ethers.parseEther('1')),
		).to.be.revertedWith('VM: wklc is reserve');
		// non-reserve tokens still rescuable
		await (dai as any).mint(vm.target, ethers.parseEther('5'));
		await vm.connect(admin).rescueERC20(dai.target, treasury.address, ethers.parseEther('5'));
	});
});
