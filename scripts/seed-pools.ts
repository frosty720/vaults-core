import { ethers } from 'hardhat'

// Creates + initializes + seeds the WKLC/stable V3 pools that VaultManager's POL
// path swaps and LP-mints into. None exist on testnet yet, so a purchase would
// revert ('VM: pool not ready' / router no-pool). Run once per stable, idempotent:
// skips pool creation if the pool already exists and skips the mint if it already
// holds liquidity.
//
//   KLC_USD=0.0024 FEE=3000 npx hardhat run scripts/seed-pools.ts --network testnet
//
// The pool is initialized at KLC_USD (USD price of 1 KLC). This MUST match the
// operator referencePrice you set later, or the first POL mint reverts on the LP
// min-amount check (post-swap ratio mismatch). See BUILD_STATUS.md step 7.

// --- testnet (3889) addresses ---
const FACTORY = '0x709E8f0C1dd43C81263fEAe6f0847E2d6506e57b'
const NPM = '0x8064558662896B2941B2BF88eb51182b4152d61B'
const WKLC = '0x069255299Bb729399f3CECaBdc73d15d3D10a2A3' // 18 dec, WETH9-style

interface StableSpec {
	name: string
	address: string
	decimals: number
	// whole units of stable to seed; WKLC side is value-matched from KLC_USD.
	// KUSD defaults small because it must be CDP-minted first (dust floor 50).
	seedWhole: bigint
}

const STABLES: StableSpec[] = [
	{ name: 'KUSD', address: '0xd15F19c457AaaCB7A389B305Dac8611Cd2294c36', decimals: 18, seedWhole: BigInt(process.env.SEED_KUSD ?? '150') },
	{ name: 'USDT', address: '0x6Fdb0fEd277b878a0d80494b06EA054C99d2fdD2', decimals: 6, seedWhole: BigInt(process.env.SEED_USDT ?? '200') },
	{ name: 'DAI', address: '0x1e7B8b36b703dDdAAe1bCfedF7BB3876D87b35F3', decimals: 18, seedWhole: BigInt(process.env.SEED_DAI ?? '200') },
	{ name: 'USDC', address: '0x148d19609F3Ad595F8455225510f89cF0F121013', decimals: 6, seedWhole: BigInt(process.env.SEED_USDC ?? '200') },
]

const FEE = Number(process.env.FEE ?? '3000') // 0.3% — correct tier for volatile/stable (KLC vs stable)
// TOP_UP=1 mints ADDITIONAL full-range liquidity into already-seeded pools (deepen for larger
// tier buys). Without it, pools that already hold liquidity are skipped.
const TOP_UP = process.env.TOP_UP === '1'
const KLC_USD = process.env.KLC_USD ?? '0.0024' // live mainnet V2: ~0.00233 KUSD, ~0.00243 USDT per KLC

// KalyChain (Besu) returns "Internal error" on eth_estimateGas, so pass explicit
// legacy gas on every tx: gasPrice => legacy (type-0) tx, gasLimit => skip estimation.
// Mirrors the cast `--legacy --gas-price 21gwei --gas-limit` pattern documented in
// KUSD/docs/TESTNET_TESTING.md.
const GAS_PRICE = 21000000000n // 21 gwei
const GAS_CREATE = 6_000_000n // pool contract deploy + initialize
const GAS_MINT = 1_500_000n // full-range position mint
const GAS_SMALL = 200_000n // approve / wrap

const FACTORY_ABI = ['function getPool(address,address,uint24) view returns (address)']
const NPM_ABI = [
	'function createAndInitializePoolIfNecessary(address token0,address token1,uint24 fee,uint160 sqrtPriceX96) payable returns (address pool)',
	'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
]
const POOL_ABI = [
	'function liquidity() view returns (uint128)',
	'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)',
]
const ERC20_ABI = [
	'function balanceOf(address) view returns (uint256)',
	'function allowance(address,address) view returns (uint256)',
	'function approve(address,uint256) returns (bool)',
	'function decimals() view returns (uint8)',
]
const WKLC_ABI = [...ERC20_ABI, 'function deposit() payable']

function tickSpacing(fee: number): number {
	if (fee === 10000) return 200
	if (fee === 3000) return 60
	if (fee === 500) return 10
	if (fee === 100) return 1
	throw new Error(`unknown fee tier ${fee}`)
}

// Integer sqrt (Newton) for bigint — no float precision loss.
function sqrtBI(n: bigint): bigint {
	if (n < 0n) throw new Error('sqrt of negative')
	if (n < 2n) return n
	let x = n
	let y = (x + 1n) / 2n
	while (y < x) {
		x = y
		y = (x + n / x) / 2n
	}
	return x
}

// Parse a decimal string like "0.0024" into an exact num/den fraction.
function priceFraction(s: string): { num: bigint; den: bigint } {
	const [whole, frac = ''] = s.split('.')
	const num = BigInt(whole + frac)
	const den = 10n ** BigInt(frac.length)
	return { num, den }
}

// sqrtPriceX96 = sqrt(price) * 2^96, where price = (token1 raw / token0 raw).
// token0 = WKLC (18 dec) in every KalyChain pool (lowest address). For 1 WKLC
// (1e18 raw) worth KLC_USD of stable: amount1 = KLC_USD * 10^stableDec.
function sqrtPriceX96ForWklcToken0(klcUsd: string, stableDecimals: number): bigint {
	const { num, den } = priceFraction(klcUsd)
	const amount1 = num * 10n ** BigInt(stableDecimals) // stable raw per 1 WKLC, scaled by den
	const amount0 = den * 10n ** 18n // 1 WKLC raw, scaled by den
	const ratioX192 = (amount1 << 192n) / amount0
	return sqrtBI(ratioX192)
}

async function main() {
	const [signer] = await ethers.getSigners()
	const me = await signer.getAddress()
	console.log(`Seeder: ${me}`)
	console.log(`KLC_USD=${KLC_USD}  FEE=${FEE}  spacing=${tickSpacing(FEE)}\n`)

	const factory = new ethers.Contract(FACTORY, FACTORY_ABI, signer)
	const npm = new ethers.Contract(NPM, NPM_ABI, signer)
	const wklc = new ethers.Contract(WKLC, WKLC_ABI, signer)

	const spacing = tickSpacing(FEE)
	const maxUsable = Math.floor(887272 / spacing) * spacing
	const tickLower = -maxUsable
	const tickUpper = maxUsable
	const deadline = Math.floor(Date.now() / 1000) + 1200

	for (const s of STABLES) {
		console.log(`=== ${s.name} (${s.address}) ===`)
		const stable = new ethers.Contract(s.address, ERC20_ABI, signer)

		const [token0, token1] = WKLC.toLowerCase() < s.address.toLowerCase() ? [WKLC, s.address] : [s.address, WKLC]
		const sqrtP =
			token0.toLowerCase() === WKLC.toLowerCase()
				? sqrtPriceX96ForWklcToken0(KLC_USD, s.decimals)
				: (() => {
						throw new Error(`${s.name} sorts below WKLC — unexpected; recompute price inversion`)
				  })()

		// 1. Create + initialize the pool (idempotent).
		const existing: string = await factory.getPool(WKLC, s.address, FEE)
		if (existing === ethers.ZeroAddress) {
			console.log(`  creating + initializing pool @ sqrtPriceX96=${sqrtP} ...`)
			const tx = await npm.createAndInitializePoolIfNecessary(token0, token1, FEE, sqrtP, {
				gasPrice: GAS_PRICE,
				gasLimit: GAS_CREATE,
			})
			await tx.wait()
		} else {
			console.log(`  pool exists: ${existing}`)
		}
		const poolAddr: string = await factory.getPool(WKLC, s.address, FEE)
		const pool = new ethers.Contract(poolAddr, POOL_ABI, signer)
		const liq: bigint = await pool.liquidity()
		if (liq > 0n && !TOP_UP) {
			console.log(`  already has liquidity (${liq}) — skipping mint (set TOP_UP=1 to deepen).\n`)
			continue
		}
		if (liq > 0n && TOP_UP) {
			console.log(`  TOP_UP: pool has ${liq} liquidity — minting an additional position to deepen.`)
		}

		// 2. Size the position: seedWhole stable + value-matched WKLC.
		const { num, den } = priceFraction(KLC_USD)
		const stableRaw = s.seedWhole * 10n ** BigInt(s.decimals)
		// wklc = stableValueUSD / KLC_USD = seedWhole / KLC_USD, in 18-dec WKLC raw.
		const wklcRaw = (s.seedWhole * den * 10n ** 18n) / num

		// 3. Ensure balances (auto-wrap KLC into WKLC; never auto-mint stables).
		const wklcBal: bigint = await wklc.balanceOf(me)
		if (wklcBal < wklcRaw) {
			// KLC is cheap, so even a few $k of WKLC is >1M KLC. hardhat's signer
			// (micro-eth-signer) caps a single tx `value` at maxAmount = 1M ether,
			// so wrap in sub-bound chunks instead of one deposit().
			const WRAP_CHUNK = 900_000n * 10n ** 18n
			let need = wklcRaw - wklcBal
			console.log(`  wrapping ${ethers.formatEther(need)} KLC -> WKLC (chunked) ...`)
			while (need > 0n) {
				const amt = need > WRAP_CHUNK ? WRAP_CHUNK : need
				await (await wklc.deposit({ value: amt, gasPrice: GAS_PRICE, gasLimit: GAS_SMALL })).wait()
				need -= amt
			}
		}
		const stableBal: bigint = await stable.balanceOf(me)
		if (stableBal < stableRaw) {
			console.log(
				`  SKIP: need ${s.seedWhole} ${s.name} (${stableRaw}) but hold ${stableBal}. ` +
					`Mint/acquire ${s.name} first, then re-run.\n`
			)
			continue
		}

		// 4. Approve NPM for both sides.
		for (const [tok, amt, label] of [
			[wklc, wklcRaw, 'WKLC'],
			[stable, stableRaw, s.name],
		] as const) {
			const cur: bigint = await tok.allowance(me, NPM)
			if (cur < amt) {
				console.log(`  approving ${label} ...`)
				await (await tok.approve(NPM, ethers.MaxUint256, { gasPrice: GAS_PRICE, gasLimit: GAS_SMALL })).wait()
			}
		}

		// 5. Mint the full-range position. amount{0,1}Min = 0: we set the pool's
		//    initial price ourselves, so there is nothing to be sandwiched against.
		const amount0Desired = token0.toLowerCase() === WKLC.toLowerCase() ? wklcRaw : stableRaw
		const amount1Desired = token0.toLowerCase() === WKLC.toLowerCase() ? stableRaw : wklcRaw
		console.log(`  minting full-range: ${ethers.formatEther(wklcRaw)} WKLC + ${s.seedWhole} ${s.name} ...`)
		const tx = await npm.mint({
			token0,
			token1,
			fee: FEE,
			tickLower,
			tickUpper,
			amount0Desired,
			amount1Desired,
			amount0Min: 0n,
			amount1Min: 0n,
			recipient: me,
			deadline,
		}, { gasPrice: GAS_PRICE, gasLimit: GAS_MINT })
		const rc = await tx.wait()
		const after: bigint = await pool.liquidity()
		console.log(`  done (tx ${rc?.hash}). pool ${poolAddr} liquidity=${after}\n`)
	}

	console.log('Seeding pass complete. Re-run after minting any SKIPPED stables.')
}

main().catch((e) => {
	console.error(e)
	process.exitCode = 1
})
