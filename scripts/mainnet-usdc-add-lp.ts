import { ethers } from 'hardhat'

// mainnet-usdc-add-lp.ts — add wallet USDC + value-matched WKLC to the WKLC/USDC 0.3%
// pool as a FULL-RANGE position (2026-08-17). Written because the KalySwap add-liquidity
// UI currently displays this pair's price inverted and fails to derive the counterpart
// amount — minting through it is not trustworthy for this pair.
//
// Deposits the wallet's whole USDC balance (override with ADD_USDC=<whole dollars>) and
// computes the WKLC side from the pool's LIVE spot at run time (wrapping KLC if the
// wallet's WKLC is short). Position NFT goes to the signer.
//
// Run:  npx hardhat run scripts/mainnet-usdc-add-lp.ts --network mainnet

const NPM_ADDR = '0xfa25364Ec856E1C0dd6D14568456C842b288E519'
const WKLC_ADDR = '0x069255299Bb729399f3CECaBdc73d15d3D10a2A3'
const USDC_ADDR = '0x9cAb0c396cF0F4325913f2269a0b72BD4d46E3A9'
const POOL_ADDR = '0x65dd443dfc57f9731ae0fd157b8999976f5fe8ae'
const USDT_POOL = '0x3848c7c8d088549194a264cb1d639258abe406a9' // sanity anchor for the spot
const FEE = 3000
const TICK_SPACING = 60n
const Q192 = 2n ** 192n

// Besu errors on eth_estimateGas: pin explicit legacy gas.
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

// WKLC wei per 1.0 whole USDC, from the pool's sqrtPriceX96 (WKLC is token0).
const refFromSqrtPrice = (sp: bigint): bigint => (Q192 * 10n ** 6n) / (sp * sp)

async function main() {
	const { chainId } = await ethers.provider.getNetwork()
	if (chainId !== 3888n) throw new Error(`mainnet (3888) only — connected to ${chainId}`)
	const [signer] = await ethers.getSigners()
	const me = await signer.getAddress()

	const npm = new ethers.Contract(NPM_ADDR, NPM_ABI, signer)
	const wklc = new ethers.Contract(WKLC_ADDR, WKLC_ABI, signer)
	const usdc = new ethers.Contract(USDC_ADDR, ERC20_ABI, signer)
	const pool = new ethers.Contract(POOL_ADDR, POOL_ABI, signer)
	const usdtPool = new ethers.Contract(USDT_POOL, POOL_ABI, signer)

	// ── preconditions ──
	const liq: bigint = await pool.liquidity()
	if (liq === 0n) throw new Error('pool has no liquidity — run mainnet-usdc-bootstrap.ts first')
	const spot: bigint = (await pool.slot0())[0]
	const ref = refFromSqrtPrice(spot)
	const anchorRef = refFromSqrtPrice((await usdtPool.slot0())[0])
	const skewBps = ref > anchorRef ? ((ref - anchorRef) * 10000n) / anchorRef : ((anchorRef - ref) * 10000n) / anchorRef
	console.log(`spot: ${ref} WKLC/$1 (≈$${(1e18 / Number(ref)).toFixed(6)}/KLC), vs USDT pool skew ${skewBps} bps`)
	if (skewBps > 3000n) throw new Error('USDC pool >30% off the USDT pool — possible manipulation wick, refusing to mint')

	// ── amounts: wallet USDC (or ADD_USDC whole dollars) + value-matched WKLC ──
	const usdcBal: bigint = await usdc.balanceOf(me)
	const usdcAmt = process.env.ADD_USDC ? BigInt(process.env.ADD_USDC) * 10n ** 6n : usdcBal
	if (usdcAmt === 0n || usdcAmt > usdcBal) throw new Error(`bad USDC amount ${usdcAmt} (wallet has ${usdcBal})`)
	const wklcAmt = (usdcAmt * ref) / 10n ** 6n
	const wklcBal: bigint = await wklc.balanceOf(me)
	if (wklcBal < wklcAmt) {
		const short = wklcAmt - wklcBal
		console.log(`wrapping ${ethers.formatEther(short)} KLC to cover the WKLC side`)
		await (await wklc.deposit({ value: short, ...GAS })).wait()
	}
	console.log(`adding ${Number(usdcAmt) / 1e6} USDC + ${ethers.formatEther(wklcAmt)} WKLC, full range`)

	// ── mint ──
	await (await usdc.approve(NPM_ADDR, usdcAmt, GAS)).wait()
	await (await wklc.approve(NPM_ADDR, wklcAmt, GAS)).wait()
	const tickMax = (887272n / TICK_SPACING) * TICK_SPACING
	const rc = await (await npm.mint({
		token0: WKLC_ADDR, token1: USDC_ADDR, fee: FEE,
		tickLower: -tickMax, tickUpper: tickMax,
		amount0Desired: wklcAmt, amount1Desired: usdcAmt,
		amount0Min: (wklcAmt * 90n) / 100n, amount1Min: (usdcAmt * 90n) / 100n,
		recipient: me, deadline: BigInt(Math.floor(Date.now() / 1000) + 900),
	}, GAS)).wait()
	if (rc!.status !== 1) throw new Error('mint reverted')

	// IncreaseLiquidity(tokenId, liquidity, amount0, amount1) — read consumed amounts back.
	const incTopic = ethers.id('IncreaseLiquidity(uint256,uint128,uint256,uint256)')
	const inc = rc!.logs.find((l) => l.topics[0] === incTopic)
	if (inc) {
		const tokenId = BigInt(inc.topics[1]!)
		const [, a0, a1] = ethers.AbiCoder.defaultAbiCoder().decode(['uint128', 'uint256', 'uint256'], inc.data)
		console.log(`minted position #${tokenId}: consumed ${ethers.formatEther(a0)} WKLC + ${Number(a1) / 1e6} USDC (tx ${rc!.hash})`)
	} else {
		console.log(`minted (tx ${rc!.hash}) — check position on KalyScan`)
	}
	console.log(`wallet after: ${Number(await usdc.balanceOf(me)) / 1e6} USDC, ${ethers.formatEther(await wklc.balanceOf(me))} WKLC`)
	console.log('ADD-LP COMPLETE ✅')
}

main().catch((e) => { console.error(e); process.exit(1) })
