import { ethers } from 'hardhat'

// dryrun-usdc-bootstrap.ts — TESTNET rehearsal of the mainnet USDC enablement (2026-08-17).
//
// Mainnet reality this mirrors: the WKLC/USDC 0.3% pool (0x65dd443d…) exists with ZERO
// liquidity and an INVERTED init price (~417 USDC/WKLC instead of ~0.0024 — someone fed
// createAndInitializePoolIfNecessary the reciprocal). The rehearsal recreates that exact
// state with a throwaway mock USDC and walks the full bootstrap.
//
// Why not a "dust swap" to fix the price: SwapRouter02's swap callback requires
// `amount0Delta > 0 || amount1Delta > 0` — swaps entirely within zero-liquidity regions
// are unsupported (empty revert; verified on testnet tx 0xcdc65504…). So instead:
//
//   1. deploy MockERC20 'USDC2' (6 dec), mint to deployer
//   2. create WKLC/USDC2 0.3% pool initialized at the INVERTED price (the mainnet mistake)
//   3. setStable + setReferencePrice(correct) + setBuyParams(300, 1) (mainnet-parity floor)
//   4. static-call purchase against the EMPTY pool -> MUST revert (proves a purchase can
//      never bootstrap an empty pool; PolLib always swaps >= minBuyUsd through it)
//   5. BAND BOOTSTRAP: mint ~$SEED_USD of USDC2 single-sided in a band around the CORRECT
//      tick (price is above the band -> position takes zero WKLC), then sell WKLC into it
//      with sqrtPriceLimitX96 = correct price -> real deltas (router allows it), price
//      lands exactly on target, pool ends holding ~$SEED_USD straddling the true price
//   6. real purchase of tier 0 (Starter $50) -> verify events, NFT, POL position, fee split
//   7. restore: setBuyParams(300, 100) (historical testnet value) + disable USDC2
//
// Run:  npx hardhat run scripts/dryrun-usdc-bootstrap.ts --network testnet
// Env:  SEED_USD (default 10), KLC_USD override (default: derived from anchor ref price)

const VM_ADDR = '0xb02f6b79CbB549F188c90f83035dD295d8AdF082'
const NPM_ADDR = '0x8064558662896B2941B2BF88eb51182b4152d61B'
const ROUTER_ADDR = '0x3246523054b0Bb123372ecf204740Cb04f6E713e'
const WKLC_ADDR = '0x069255299Bb729399f3CECaBdc73d15d3D10a2A3'
const ANCHOR_USDT = '0x6Fdb0fEd277b878a0d80494b06EA054C99d2fdD2'
const FEE = 3000
const TICK_SPACING = 60
const BAND_HALF_TICKS = 3000 // ±~35% price band around the target tick
const Q96 = 2n ** 96n
const Q192 = 2n ** 192n

// Besu errors on eth_estimateGas: pin explicit legacy gas everywhere (same as seed-pools.ts).
const GAS = { gasPrice: 21_000_000_000n, gasLimit: 6_000_000n }

const ERC20_ABI = [
	'function approve(address,uint256) returns (bool)',
	'function balanceOf(address) view returns (uint256)',
]
const WKLC_ABI = [...ERC20_ABI, 'function deposit() payable']
const FACTORY_ABI = ['function getPool(address,address,uint24) view returns (address)']
const POOL_ABI = [
	'function liquidity() view returns (uint128)',
	'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)',
]
const NPM_ABI = [
	'function createAndInitializePoolIfNecessary(address,address,uint24,uint160) payable returns (address)',
	'function factory() view returns (address)',
	'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
	'function ownerOf(uint256) view returns (address)',
]
const ROUTER_ABI = [
	'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)',
]
const VM_ABI = [
	'function setStable(address,bool,uint8,address,uint24)',
	'function setReferencePrice(address,uint256)',
	'function setBuyParams(uint16,uint256)',
	'function referencePrice(address) view returns (uint256)',
	'function minBuyUsd() view returns (uint256)',
	'function buyImpactBps() view returns (uint16)',
	'function purchase(uint8,address,uint256) returns (uint256)',
	'function ownerOf(uint256) view returns (address)',
	'function treasury() view returns (address)',
	'function tiers(uint256) view returns (uint256 priceUSD,uint16 aprBps,uint256 weight,string metadataURI,bool active)',
	'event Purchased(address indexed buyer, uint256 indexed tokenId, uint8 tier, address stable, uint256 paid)',
	'event PolDeployed(address indexed stable, uint256 swapped, uint256 wklcOut, uint256 positionId)',
	'event PolRefundToTreasury(address indexed stable, uint256 amount)',
	'event FeesRouted(address indexed buyer, address indexed stable, address n1, address n2, address n3, uint256 a1, uint256 a2, uint256 a3, uint256 devAmt, uint256 toDao)',
]

function bigintSqrt(n: bigint): bigint {
	if (n < 2n) return n
	let x = n, y = (x + 1n) / 2n
	while (y < x) { x = y; y = (x + n / x) / 2n }
	return x
}

// sqrtPriceX96 for a human price of `usdPerKlc` (whole stable per whole WKLC) held as a
// fraction num/den, adjusted for token ordering and the 18-vs-6 decimal gap.
function sqrtPriceX96For(usdPerKlcNum: bigint, usdPerKlcDen: bigint, wklcIsToken0: boolean): bigint {
	const [n, d] = wklcIsToken0
		? [usdPerKlcNum, usdPerKlcDen * 10n ** 12n]
		: [usdPerKlcDen * 10n ** 12n, usdPerKlcNum]
	return bigintSqrt((n * Q192) / d)
}

// referencePrice = WKLC wei per 1.0 whole stable, from a pool sqrtPriceX96.
function refFromSqrtPrice(sp: bigint, wklcIsToken0: boolean): bigint {
	return wklcIsToken0 ? (Q192 * 10n ** 6n) / (sp * sp) : (sp * sp * 10n ** 6n) / Q192
}

function tickFromSqrtPrice(sp: bigint): number {
	const raw = (Number(sp) / Number(Q96)) ** 2
	return Math.floor(Math.log(raw) / Math.log(1.0001))
}

const alignDown = (tick: number) => Math.floor(tick / TICK_SPACING) * TICK_SPACING

async function main() {
	const { chainId } = await ethers.provider.getNetwork()
	if (chainId !== 3889n) throw new Error(`testnet (3889) only — connected to ${chainId}`)
	const [signer] = await ethers.getSigners()
	const me = await signer.getAddress()
	console.log(`deployer: ${me}`)

	const vm = new ethers.Contract(VM_ADDR, VM_ABI, signer)
	const npm = new ethers.Contract(NPM_ADDR, NPM_ABI, signer)
	const router = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, signer)
	const wklc = new ethers.Contract(WKLC_ADDR, WKLC_ABI, signer)

	// KLC/USD as a bigint fraction num/den; default derived from the anchor USDT ref price.
	let usdNum: bigint, usdDen: bigint
	if (process.env.KLC_USD) {
		const s = process.env.KLC_USD
		const dp = (s.split('.')[1] ?? '').length
		usdNum = BigInt(s.replace('.', ''))
		usdDen = 10n ** BigInt(dp)
	} else {
		const anchorRef: bigint = await vm.referencePrice(ANCHOR_USDT)
		usdNum = 10n ** 18n
		usdDen = anchorRef
	}
	console.log(`KLC/USD ≈ ${(Number(usdNum) / Number(usdDen)).toFixed(6)}`)

	// ── 1. throwaway mock USDC ──
	const Mock = await ethers.getContractFactory('MockERC20')
	const usdc2 = await Mock.deploy('USD Coin Dryrun', 'USDC2', 6, GAS)
	await usdc2.waitForDeployment()
	const USDC2 = await usdc2.getAddress()
	await (await usdc2.mint(me, 1_000n * 10n ** 6n, GAS)).wait()
	console.log(`1. USDC2 deployed ${USDC2}, minted 1000`)

	const wklcIsToken0 = WKLC_ADDR.toLowerCase() < USDC2.toLowerCase()
	const [t0, t1] = wklcIsToken0 ? [WKLC_ADDR, USDC2] : [USDC2, WKLC_ADDR]

	// ── 2. create pool at the INVERTED price (recreate the mainnet mistake) ──
	const invertedSqrt = sqrtPriceX96For(usdDen, usdNum, wklcIsToken0)
	await (await npm.createAndInitializePoolIfNecessary(t0, t1, FEE, invertedSqrt, GAS)).wait()
	const factory = new ethers.Contract(await npm.factory(), FACTORY_ABI, signer)
	const poolAddr: string = await factory.getPool(WKLC_ADDR, USDC2, FEE)
	const pool = new ethers.Contract(poolAddr, POOL_ABI, signer)
	let slot0 = await pool.slot0()
	console.log(`2. pool ${poolAddr} created INVERTED: tick=${slot0[1]}`)

	// ── 3. enable the stable at the CORRECT reference price, mainnet-parity buy params ──
	const targetSqrt = sqrtPriceX96For(usdNum, usdDen, wklcIsToken0)
	const targetTick = tickFromSqrtPrice(targetSqrt)
	const spotRef = refFromSqrtPrice(targetSqrt, wklcIsToken0)
	await (await vm.setStable(USDC2, true, 6, poolAddr, FEE, GAS)).wait()
	await (await vm.setReferencePrice(USDC2, spotRef, GAS)).wait()
	const prevMinBuy: bigint = await vm.minBuyUsd()
	const prevImpact: bigint = await vm.buyImpactBps()
	await (await vm.setBuyParams(300, 1, GAS)).wait()
	console.log(`3. setStable + ref=${spotRef} (WKLC wei per $1) + buyParams 300/1 (was ${prevImpact}/${prevMinBuy}); target tick ${targetTick}`)

	// ── 4. prove the empty-pool first buy reverts ──
	const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 900)
	await (await usdc2.approve(VM_ADDR, 100n * 10n ** 6n, GAS)).wait()
	try {
		await vm.purchase.staticCall(0, USDC2, deadline(), GAS)
		throw new Error('UNEXPECTED: purchase against empty pool did NOT revert — seed assumption wrong')
	} catch (e: any) {
		if (String(e.message).includes('UNEXPECTED')) throw e
		console.log('4. empty-pool purchase reverts as predicted ✓')
	}

	// ── 5. band bootstrap: single-sided stable band around the correct tick, then swap into it ──
	const seedUsd = BigInt(process.env.SEED_USD ?? '10')
	const seedStable = seedUsd * 10n ** 6n
	const tickLower = alignDown(targetTick - BAND_HALF_TICKS)
	const tickUpper = alignDown(targetTick + BAND_HALF_TICKS)
	// Sanity: the band must sit entirely on the stable side of the current (wrong) price so the
	// mint takes zero WKLC. Wrong price overvalues WKLC -> current tick is far on the WKLC-rich
	// side; for wklc=token0 that means current tick ABOVE the band, else below.
	const curTick = Number(slot0[1])
	if (wklcIsToken0 ? curTick <= tickUpper : curTick >= tickLower) throw new Error('band not single-sided vs current price')
	await (await usdc2.approve(NPM_ADDR, seedStable, GAS)).wait()
	const [amt0, amt1] = wklcIsToken0 ? [0n, seedStable] : [seedStable, 0n]
	await (await npm.mint({
		token0: t0, token1: t1, fee: FEE,
		tickLower, tickUpper,
		amount0Desired: amt0, amount1Desired: amt1,
		amount0Min: (amt0 * 90n) / 100n, amount1Min: (amt1 * 90n) / 100n,
		recipient: me, deadline: deadline(),
	}, GAS)).wait()
	console.log(`5a. minted $${seedUsd} USDC2 single-sided band [${tickLower}, ${tickUpper}]`)

	// Sell WKLC into the band until the price lands exactly on target ($SEED_USD covers the
	// ~half-band worth consumed; unspent input stays in the wallet — exact-input partial fill).
	const wklcBudget = (seedUsd * 10n ** 18n * usdDen) / usdNum // $seedUsd of WKLC, ≥2x what's needed
	await (await wklc.deposit({ value: wklcBudget, ...GAS })).wait()
	await (await wklc.approve(ROUTER_ADDR, wklcBudget, GAS)).wait()
	await (await router.exactInputSingle({
		tokenIn: WKLC_ADDR, tokenOut: USDC2, fee: FEE,
		recipient: me, amountIn: wklcBudget, amountOutMinimum: 0n,
		sqrtPriceLimitX96: targetSqrt,
	}, GAS)).wait()
	slot0 = await pool.slot0()
	const gotSqrt = BigInt(slot0[0])
	const devBps = gotSqrt > targetSqrt ? ((gotSqrt - targetSqrt) * 10000n) / targetSqrt : ((targetSqrt - gotSqrt) * 10000n) / targetSqrt
	console.log(`5b. price landed: tick=${slot0[1]} (target ${targetTick}, sqrt off by ${devBps} bps), pool liq=${await pool.liquidity()}`)
	if (devBps > 10n) throw new Error('price did not land on target')

	// ── 6. the real first purchase: tier 0 (Starter $50) ──
	const tier0 = await vm.tiers(0)
	const treasury: string = await vm.treasury()
	const balBefore = { pool: await usdc2.balanceOf(poolAddr), treas: await usdc2.balanceOf(treasury) }
	const rc = await (await vm.purchase(0, USDC2, deadline(), GAS)).wait()
	if (rc!.status !== 1) throw new Error('purchase tx reverted')
	const evs: Record<string, any> = {}
	for (const log of rc!.logs) {
		try {
			const p = vm.interface.parseLog({ topics: [...log.topics], data: log.data })
			if (p) evs[p.name] = p.args
		} catch { /* other contracts' logs */ }
	}
	if (!evs.Purchased || !evs.PolDeployed) throw new Error(`missing events: ${Object.keys(evs).join(',')}`)
	const tokenId = evs.Purchased.tokenId
	console.log(`6. PURCHASED tier0 ($${tier0.priceUSD}) tokenId=${tokenId} paid=${Number(evs.Purchased.paid) / 1e6} USDC2`)
	console.log(`   PolDeployed: market-buy=${Number(evs.PolDeployed.swapped) / 1e6} USDC2, wklcOut=${ethers.formatEther(evs.PolDeployed.wklcOut)} WKLC, positionId=${evs.PolDeployed.positionId}`)
	console.log(`   FeesRouted: dev=${Number(evs.FeesRouted?.devAmt ?? 0) / 1e6} dao=${Number(evs.FeesRouted?.toDao ?? 0) / 1e6}`)
	if (evs.PolRefundToTreasury) console.log(`   leftover swept to treasury: ${Number(evs.PolRefundToTreasury.amount) / 1e6} USDC2`)
	console.log(`   NFT owner: ${await vm.ownerOf(tokenId)} (buyer ${me})`)
	console.log(`   POL position owner: ${await npm.ownerOf(evs.PolDeployed.positionId)} (treasury ${treasury})`)
	console.log(`   pool USDC2: ${Number(balBefore.pool) / 1e6} -> ${Number(await usdc2.balanceOf(poolAddr)) / 1e6}`)
	console.log(`   treasury USDC2: ${Number(balBefore.treas) / 1e6} -> ${Number(await usdc2.balanceOf(treasury)) / 1e6}`)

	// ── 7. restore testnet params, retire the throwaway stable ──
	await (await vm.setBuyParams(Number(prevImpact), prevMinBuy, GAS)).wait()
	await (await vm.setStable(USDC2, false, 6, poolAddr, FEE, GAS)).wait()
	console.log(`7. restored buyParams ${prevImpact}/${prevMinBuy}, USDC2 disabled. DRY RUN COMPLETE ✅`)
}

main().catch((e) => { console.error(e); process.exit(1) })
