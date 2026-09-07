import { ethers } from 'hardhat'

// mainnet-usdc-bootstrap.ts — enable USDC as a vault payment stable on MAINNET (2026-08-17).
//
// Production run of the procedure rehearsed end-to-end by scripts/dryrun-usdc-bootstrap.ts
// on testnet: the WKLC/USDC 0.3% pool (0x65dd443d…) exists with zero liquidity and an
// inverted init price (~400 USDC/WKLC — the reciprocal of the real ~$0.0025). A router
// swap cannot fix an empty pool's price (SwapRouter02 rejects zero-liquidity swaps), so:
//
//   1. mint $SEED_USD of USDC SINGLE-SIDED in a ±3000-tick band around the correct tick
//      (pool price is far above the band -> the mint takes zero WKLC and cannot be arbed)
//   2. sell WKLC into the band with sqrtPriceLimitX96 = target -> price lands exactly on
//      the live KLC/USD price (taken from the USDT pool spot); ~half the band converts to
//      WKLC, ~half the USDC returns to the wallet
//   3. setStable(USDC) + setReferencePrice(USDC, spot) on the VaultManager
//
// Mainnet buy params already fit (minBuyUsd=1, slippageBps=1500): no param changes.
//
// Run:  npx hardhat run scripts/mainnet-usdc-bootstrap.ts --network mainnet
// Env:  SEED_USD (default 50)

const VM_ADDR = '0x8ad3aD4a3F20672d39F6F87d6bdf1DF5386ac6A5'
const NPM_ADDR = '0xfa25364Ec856E1C0dd6D14568456C842b288E519'
const ROUTER_ADDR = '0xEAd6d6ea2aBbe807AC728Eb92c77865b62C41893'
const WKLC_ADDR = '0x069255299Bb729399f3CECaBdc73d15d3D10a2A3'
const USDC_ADDR = '0x9cAb0c396cF0F4325913f2269a0b72BD4d46E3A9'
const POOL_ADDR = '0x65dd443dfc57f9731ae0fd157b8999976f5fe8ae'
// Live KLC/USD source: the USDT pool spot. USDT and USDC are both 6-dec and both sort
// after WKLC (token1), so its sqrtPriceX96 IS the target for the USDC pool, verbatim.
const USDT_POOL = '0x3848c7c8d088549194a264cb1d639258abe406a9'
const FEE = 3000
const TICK_SPACING = 60
const BAND_HALF_TICKS = 3000
const Q96 = 2n ** 96n
const Q192 = 2n ** 192n

// Besu errors on eth_estimateGas: pin explicit legacy gas (gasLimit*gasPrice is the wallet
// spend ceiling per tx — 6M @ 21gwei = 0.126 KLC, negligible).
const GAS = { gasPrice: 21_000_000_000n, gasLimit: 6_000_000n }

const ERC20_ABI = [
	'function approve(address,uint256) returns (bool)',
	'function balanceOf(address) view returns (uint256)',
]
const WKLC_ABI = [...ERC20_ABI, 'function deposit() payable']
const POOL_ABI = [
	'function liquidity() view returns (uint128)',
	'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)',
]
const NPM_ABI = [
	'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
]
const ROUTER_ABI = [
	'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)',
]
const VM_ABI = [
	'function setStable(address,bool,uint8,address,uint24)',
	'function setReferencePrice(address,uint256)',
	'function referencePrice(address) view returns (uint256)',
	'function stables(address) view returns (bool enabled, uint8 decimals, address v3Pool, uint24 v3Fee)',
	'function minBuyUsd() view returns (uint256)',
	'function slippageBps() view returns (uint16)',
]

function tickFromSqrtPrice(sp: bigint): number {
	const raw = (Number(sp) / Number(Q96)) ** 2
	return Math.floor(Math.log(raw) / Math.log(1.0001))
}
const alignDown = (tick: number) => Math.floor(tick / TICK_SPACING) * TICK_SPACING

async function main() {
	const { chainId } = await ethers.provider.getNetwork()
	if (chainId !== 3888n) throw new Error(`mainnet (3888) only — connected to ${chainId}`)
	const [signer] = await ethers.getSigners()
	const me = await signer.getAddress()

	const vm = new ethers.Contract(VM_ADDR, VM_ABI, signer)
	const npm = new ethers.Contract(NPM_ADDR, NPM_ABI, signer)
	const router = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, signer)
	const wklc = new ethers.Contract(WKLC_ADDR, WKLC_ABI, signer)
	const usdc = new ethers.Contract(USDC_ADDR, ERC20_ABI, signer)
	const pool = new ethers.Contract(POOL_ADDR, POOL_ABI, signer)
	const usdtPool = new ethers.Contract(USDT_POOL, POOL_ABI, signer)

	// ── preconditions: bail out rather than act on a state we didn't verify ──
	const seedUsd = BigInt(process.env.SEED_USD ?? '50')
	const seedStable = seedUsd * 10n ** 6n
	const liq: bigint = await pool.liquidity()
	if (liq !== 0n) throw new Error(`pool already has liquidity (${liq}) — bootstrap window is over, do not run`)
	const st = await vm.stables(USDC_ADDR)
	if (st.enabled) throw new Error('USDC already enabled on VaultManager — nothing to do')
	const usdcBal: bigint = await usdc.balanceOf(me)
	if (usdcBal < seedStable) throw new Error(`need ${seedUsd} USDC, wallet has ${Number(usdcBal) / 1e6}`)
	console.log(`deployer ${me}: ${Number(usdcBal) / 1e6} USDC, minBuyUsd=${await vm.minBuyUsd()}, slippageBps=${await vm.slippageBps()}`)

	// ── target price = USDT pool spot (same decimals + token ordering, so 1:1) ──
	const targetSqrt: bigint = (await usdtPool.slot0())[0]
	const targetTick = tickFromSqrtPrice(targetSqrt)
	const spotRef = (Q192 * 10n ** 6n) / (targetSqrt * targetSqrt) // WKLC wei per $1
	const klcUsd = 1e18 / Number(spotRef)
	console.log(`target: tick ${targetTick}, KLC/USD ≈ $${klcUsd.toFixed(6)}, ref ${spotRef}`)

	let slot0 = await pool.slot0()
	const curTick = Number(slot0[1])
	const tickLower = alignDown(targetTick - BAND_HALF_TICKS)
	const tickUpper = alignDown(targetTick + BAND_HALF_TICKS)
	if (curTick <= tickUpper) throw new Error(`current tick ${curTick} not above band top ${tickUpper} — mint would not be single-sided`)

	// ── 1. single-sided USDC band around the correct price ──
	await (await usdc.approve(NPM_ADDR, seedStable, GAS)).wait()
	const mintRc = await (await npm.mint({
		token0: WKLC_ADDR, token1: USDC_ADDR, fee: FEE,
		tickLower, tickUpper,
		amount0Desired: 0n, amount1Desired: seedStable,
		amount0Min: 0n, amount1Min: (seedStable * 90n) / 100n,
		recipient: me, deadline: BigInt(Math.floor(Date.now() / 1000) + 900),
	}, GAS)).wait()
	if (mintRc!.status !== 1) throw new Error('band mint reverted')
	console.log(`1. minted $${seedUsd} USDC band [${tickLower}, ${tickUpper}] (tx ${mintRc!.hash})`)

	// ── 2. sell WKLC into the band until the price lands exactly on target ──
	const budget = seedUsd * spotRef // $seedUsd of WKLC in wei (~2x the ~half-band actually consumed)
	const have: bigint = await wklc.balanceOf(me)
	if (have < budget) await (await wklc.deposit({ value: budget - have, ...GAS })).wait()
	await (await wklc.approve(ROUTER_ADDR, budget, GAS)).wait()
	const swapRc = await (await router.exactInputSingle({
		tokenIn: WKLC_ADDR, tokenOut: USDC_ADDR, fee: FEE,
		recipient: me, amountIn: budget, amountOutMinimum: 0n,
		sqrtPriceLimitX96: targetSqrt,
	}, GAS)).wait()
	if (swapRc!.status !== 1) throw new Error('positioning swap reverted')
	slot0 = await pool.slot0()
	const gotSqrt: bigint = slot0[0]
	const devBps = gotSqrt > targetSqrt ? ((gotSqrt - targetSqrt) * 10000n) / targetSqrt : ((targetSqrt - gotSqrt) * 10000n) / targetSqrt
	console.log(`2. price landed: tick ${slot0[1]} (target ${targetTick}, off ${devBps} bps), liq ${await pool.liquidity()} (tx ${swapRc!.hash})`)
	if (devBps > 10n) throw new Error('price did not land on target — DO NOT enable the stable; investigate')

	// ── 3. enable on the VaultManager ──
	await (await vm.setStable(USDC_ADDR, true, 6, POOL_ADDR, FEE, GAS)).wait()
	await (await vm.setReferencePrice(USDC_ADDR, spotRef, GAS)).wait()
	const after = await vm.stables(USDC_ADDR)
	console.log(`3. setStable enabled=${after.enabled} dec=${after.decimals} pool=${after.v3Pool} fee=${after.v3Fee}`)
	console.log(`   referencePrice=${await vm.referencePrice(USDC_ADDR)}`)
	console.log(`   wallet after: ${Number(await usdc.balanceOf(me)) / 1e6} USDC, ${ethers.formatEther(await wklc.balanceOf(me))} WKLC`)
	console.log('MAINNET USDC BOOTSTRAP COMPLETE ✅ — next: config parity (deploy.config, dApp, reprice.sh) + smoke buy')
}

main().catch((e) => { console.error(e); process.exit(1) })
