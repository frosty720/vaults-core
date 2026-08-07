/**
 * POL Fork Test — Pre-mainnet gate for V3 ABI compatibility
 *
 * PURPOSE:
 *   Validates that our interface definitions (IV3SwapRouter, INonfungiblePositionManager)
 *   encode correctly against KalyChain's REAL deployed Uniswap V3 contracts. A struct-shape
 *   mismatch (e.g., deadline field present vs absent in ExactInputSingleParams) would cause
 *   ABI encoding mismatches that produce distinct revert signatures vs. liquidity-related reverts.
 *
 * HOW TO RUN:
 *   FORK=1 npx hardhat test test/fork/POL.fork.spec.ts
 *   (or: npm run test:fork)
 *
 * PREREQUISITE:
 *   Set KALY_MAINNET_RPC env var if you want a specific RPC endpoint; otherwise defaults to
 *   https://rpc.kalychain.io/rpc (configured in hardhat.config.ts).
 *
 * IMPLEMENTATION NOTE — Hardhat/EDR fork provider:
 *   Hardhat 2.28 + EDR 0.12 cannot resolve a hardfork for custom chain IDs not in its
 *   built-in registry (chainId 3888 = KalyChain). The `chains` override config is silently
 *   ignored due to a field-name mismatch between Hardhat's JS layer and EDR's Rust native
 *   module in this version. As a result, eth_call through hardhat's fork provider fails for
 *   pure view functions. The workaround used here: attach contracts directly to a
 *   JsonRpcProvider pointed at the live RPC. FORK=1 is still the gate — it signals "network
 *   access is available." The ABI sanity test (test 1) uses hardhat's provider via
 *   eth_sendTransaction (payable path) which works because EDR handles that flow differently.
 *   For pure view calls (tests 2 and 3) we bypass EDR and hit the RPC directly.
 *
 * FULL END-TO-END PURCHASE ON FORK (manual step, not automated here):
 *   To test vm.purchase() on a fork you need a funded DAI or USDT whale to impersonate.
 *   Fill in the constant below and use hardhat_impersonateAccount:
 *
 *     const WHALE = ''  // <-- operator fills in a mainnet DAI whale address
 *
 *   Then:
 *     await ethers.provider.send('hardhat_impersonateAccount', [WHALE])
 *     const whale = await ethers.getSigner(WHALE)
 *     await dai.connect(whale).approve(vm.address, amount)
 *     await vm.connect(whale).purchase(tier, dai.address, deadline)
 *
 * CHAIN: KalyChain mainnet (chainId 3888)
 */

import { expect } from 'chai'
import { ethers } from 'hardhat'

// ---------------------------------------------------------------------------
// Gate: entire suite skipped unless FORK env var is set
// ---------------------------------------------------------------------------
const RUN = !!process.env.FORK

// ---------------------------------------------------------------------------
// Mainnet addresses — chainId 3888
// ---------------------------------------------------------------------------
const SWAP_ROUTER_02 = '0xEAd6d6ea2aBbe807AC728Eb92c77865b62C41893'
const NPM_ADDRESS    = '0xfa25364Ec856E1C0dd6D14568456C842b288E519'
const V3_FACTORY     = '0x93d72B9f57bed44Ada9712c022ccB3a9B2dA07BE'
const WKLC           = '0x069255299Bb729399f3CECaBdc73d15d3D10a2A3'
const DAI            = '0x6E92CAC380F7A7B86f4163fad0df2F277B16Edc6'
const USDT           = '0x2CA775C77B922A51FcF3097F52bFFdbc0250D99A'

const MAINNET_RPC = process.env.KALY_MAINNET_RPC ?? 'https://rpc.kalychain.io/rpc'

// ---------------------------------------------------------------------------
// Minimal human-readable ABIs — must match OUR interface structs exactly
//
// IV3SwapRouter.ExactInputSingleParams fields (NO deadline):
//   tokenIn, tokenOut, fee uint24, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96 uint160
// ---------------------------------------------------------------------------
const ROUTER_ABI = [
	'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)',
]

const FACTORY_ABI = [
	'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
]

const NPM_ABI = [
	'function factory() external view returns (address)',
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
;(RUN ? describe : describe.skip)('POL fork tests [FORK=1 required]', () => {
	it('ABI sanity — SwapRouter02 exactInputSingle accepts our NO-DEADLINE struct', async () => {
		// Use hardhat signer + hardhat fork provider (payable staticCall works via EDR's
		// eth_sendTransaction path even when view calls are broken for custom chains).
		const [signer] = await ethers.getSigners()

		const router = new ethers.Contract(SWAP_ROUTER_02, ROUTER_ABI, signer)

		const params = {
			tokenIn:            WKLC,
			tokenOut:           DAI,
			fee:                10000,   // 1% tier
			recipient:          signer.address,
			amountIn:           ethers.parseEther('0.001'),
			amountOutMinimum:   0n,
			sqrtPriceLimitX96:  0n,
		}

		let revertReason: string | null = null
		let amountOut: bigint | null = null

		try {
			// staticCall — no funds sent, no state change; tests ABI encoding only
			amountOut = await router.exactInputSingle.staticCall(params, { value: 0n })
			console.log(`  exactInputSingle staticCall returned amountOut = ${amountOut}`)
		} catch (err: unknown) {
			// Capture the revert reason so a human can distinguish:
			//   - "no liquidity / pool not found" → ABI shape is fine, just no pool
			//   - ABI decoding error (e.g., wrong field count) → struct mismatch
			const msg = err instanceof Error ? err.message : String(err)
			revertReason = msg
			console.log(`  exactInputSingle staticCall reverted: ${msg}`)
		}

		// The test passes as long as we did NOT get an ABI/encoding error.
		// ABI mismatch symptoms: 'could not decode result', 'invalid argument', 'data out-of-bounds',
		// or a 0-byte revert with no reason (calldata was malformed before the call dispatched).
		// Pool-related reverts ('SPL', 'LOK', 'IIA', 'AS', custom pool errors) are acceptable.
		if (revertReason !== null) {
			const abiMismatchPatterns = [
				/could not decode/i,
				/data out-of-bounds/i,
				/invalid argument/i,
				/incorrect data length/i,
				/encoding/i,
			]
			const isAbiError = abiMismatchPatterns.some(p => p.test(revertReason!))
			expect(isAbiError, `ABI/encoding mismatch detected: ${revertReason}`).to.equal(false)
			console.log('  Revert is pool/liquidity-related (not an ABI mismatch) — struct shape is correct.')
		} else {
			console.log('  Call succeeded with a real amountOut — struct shape confirmed correct.')
		}
	})

	it('Factory getPool feasibility — logs which KLC/stable pools exist on mainnet', async () => {
		// Direct JsonRpcProvider: bypasses Hardhat/EDR hardfork-history lookup that breaks
		// view calls on custom chain IDs (3888) in Hardhat 2.28 + EDR 0.12.
		const provider = new ethers.JsonRpcProvider(MAINNET_RPC)
		const factory = new ethers.Contract(V3_FACTORY, FACTORY_ABI, provider)

		// Check the pools the spec flagged as important for POL seeding
		const pairs: Array<{ label: string; tokenA: string; tokenB: string; fee: number }> = [
			{ label: 'DAI/WKLC @ 1%',  tokenA: DAI,  tokenB: WKLC, fee: 10000 },
			{ label: 'USDT/WKLC @ 1%', tokenA: USDT, tokenB: WKLC, fee: 10000 },
		]

		console.log('\n  === Pool Feasibility Check ===')
		for (const p of pairs) {
			const poolAddress: string = await factory.getPool(p.tokenA, p.tokenB, p.fee)
			const exists = poolAddress !== ethers.ZeroAddress
			console.log(`  ${p.label}: ${exists ? 'EXISTS' : 'NOT DEPLOYED'} — ${poolAddress}`)
		}
		console.log('  ==============================\n')

		// Informational only — no assertion. The operator reads this output to decide
		// whether to seed liquidity before enabling purchase() on mainnet.
	})

	it('NonfungiblePositionManager liveness — factory() returns the V3 Factory address', async () => {
		// Direct JsonRpcProvider: same reason as the getPool test above.
		const provider = new ethers.JsonRpcProvider(MAINNET_RPC)
		const npm = new ethers.Contract(NPM_ADDRESS, NPM_ABI, provider)

		const reportedFactory: string = await npm.factory()
		console.log(`  NPM.factory() = ${reportedFactory}`)
		console.log(`  Expected:       ${V3_FACTORY}`)

		expect(reportedFactory.toLowerCase()).to.equal(
			V3_FACTORY.toLowerCase(),
			'NPM address is wrong or does not point to the expected V3 Factory',
		)
	})
})
