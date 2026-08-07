import { RepriceService } from './RepriceService'
import { IContractService } from './ContractService'
import { Alerter } from '../utils/alert'
import { sqrtPriceX96ToRef } from '../utils/math'
import { KeeperConfig, StableTarget, StableChainState } from '../types'

jest.mock('../utils/logger', () => ({
	__esModule: true,
	default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const SQRT_PRICE = 3489516281201909751505n
const DECIMALS = 6
const SPOT_REF = sqrtPriceX96ToRef(SQRT_PRICE, DECIMALS) // 515500047378104247758n — real USDT-incident fixture

/** currentRef such that driftBps(SPOT_REF, currentRef) ≈ targetDriftBps (SPOT_REF is the higher side). */
function refWithDrift(spot: bigint, targetDriftBps: bigint): bigint {
	return (spot * 10_000n) / (10_000n + targetDriftBps)
}

const STABLE: StableTarget = { symbol: 'USDT', address: '0xStable', decimals: DECIMALS, pool: '0xPool' }

function buildConfig(overrides: Partial<KeeperConfig> = {}): KeeperConfig {
	return {
		rpcUrl: 'https://rpc.test',
		chainId: 3888,
		keeperPk: '0xkey',
		vaultManager: '0xVaultManager',
		stables: [STABLE],
		checkIntervalMs: 60_000,
		sampleWindow: 1, // single-sample window: median == instant, isolates orchestration from smoothing
		repriceThresholdBps: 500n,
		alertThresholdBps: 1000n,
		minRepriceIntervalMs: 600_000,
		gasLimit: 200_000n,
		dryRun: false,
		alertWebhookUrl: null,
		...overrides,
	}
}

function buildChain(overrides: Partial<StableChainState> = {}): StableChainState {
	return {
		sqrtPriceX96: SQRT_PRICE,
		currentRef: SPOT_REF, // zero drift by default
		slippageBps: 1500n,
		maxRefDeviationBps: 4000n,
		paused: false,
		...overrides,
	}
}

function buildContracts(chain: StableChainState, overrides: Partial<jest.Mocked<IContractService>> = {}): jest.Mocked<IContractService> {
	return {
		assertOperatorRole: jest.fn().mockResolvedValue(undefined),
		readStableState: jest.fn().mockResolvedValue(chain),
		setReferencePrice: jest.fn().mockResolvedValue('0xhash'),
		...overrides,
	}
}

function buildAlerter(): jest.Mocked<Alerter> {
	return { notify: jest.fn().mockResolvedValue(undefined) }
}

describe('RepriceService', () => {
	it('does nothing when drift is below every threshold', async () => {
		const contracts = buildContracts(buildChain())
		const alerter = buildAlerter()
		await new RepriceService(buildConfig(), contracts, alerter).tick()

		expect(contracts.setReferencePrice).not.toHaveBeenCalled()
		expect(alerter.notify).not.toHaveBeenCalled()
	})

	it('alerts without repricing when drift crosses the alert threshold but not enough to act', async () => {
		// 13% drift: above alertThreshold(10%), below slippage(15%) so not purchases-blocked,
		// but repriceThresholdBps raised above it here so the reprice branch is skipped.
		const chain = buildChain({ currentRef: refWithDrift(SPOT_REF, 1300n) })
		const contracts = buildContracts(chain)
		const alerter = buildAlerter()
		await new RepriceService(buildConfig({ repriceThresholdBps: 9999n }), contracts, alerter).tick()

		expect(contracts.setReferencePrice).not.toHaveBeenCalled()
		expect(alerter.notify).toHaveBeenCalledTimes(1)
		expect(alerter.notify).toHaveBeenCalledWith(expect.stringContaining('drift'), expect.objectContaining({ reason: 'drift-elevated' }))
	})

	it('reprices to the target when drift crosses the reprice threshold (not purchases-blocked)', async () => {
		// 7% drift: above repriceThreshold(5%), below slippage(15%) and below alertThreshold(10%).
		const chain = buildChain({ currentRef: refWithDrift(SPOT_REF, 700n) })
		const contracts = buildContracts(chain)
		const alerter = buildAlerter()
		await new RepriceService(buildConfig(), contracts, alerter).tick()

		expect(contracts.setReferencePrice).toHaveBeenCalledTimes(1)
		expect(contracts.setReferencePrice).toHaveBeenCalledWith('0xStable', SPOT_REF)
		// Not the severe "purchases were blocked" case, so no extra alert on top of the info log.
		expect(alerter.notify).not.toHaveBeenCalled()
	})

	it('reprices immediately and alerts when purchases are actively blocked', async () => {
		// 20% drift: above slippageBpsOnChain(15%) -> purchases-blocked path.
		const chain = buildChain({ currentRef: refWithDrift(SPOT_REF, 2000n) })
		const contracts = buildContracts(chain)
		const alerter = buildAlerter()
		await new RepriceService(buildConfig(), contracts, alerter).tick()

		expect(contracts.setReferencePrice).toHaveBeenCalledWith('0xStable', SPOT_REF)
		expect(alerter.notify).toHaveBeenCalledWith(
			expect.stringContaining('auto-repriced'),
			expect.objectContaining({ hash: '0xhash' })
		)
	})

	it('skips the reprice and alerts instead when VaultManager is paused', async () => {
		const chain = buildChain({ currentRef: refWithDrift(SPOT_REF, 700n), paused: true })
		const contracts = buildContracts(chain)
		const alerter = buildAlerter()
		await new RepriceService(buildConfig(), contracts, alerter).tick()

		expect(contracts.setReferencePrice).not.toHaveBeenCalled()
		expect(alerter.notify).toHaveBeenCalledWith(expect.stringContaining('paused'), expect.anything())
	})

	it('in DRY_RUN mode never sends a transaction and never alerts, even when purchases are blocked', async () => {
		const chain = buildChain({ currentRef: refWithDrift(SPOT_REF, 2000n) })
		const contracts = buildContracts(chain)
		const alerter = buildAlerter()
		await new RepriceService(buildConfig({ dryRun: true }), contracts, alerter).tick()

		expect(contracts.setReferencePrice).not.toHaveBeenCalled()
		expect(alerter.notify).not.toHaveBeenCalled()
	})

	it('alerts but does not throw when a send fails, and does not rate-limit-suppress the retry', async () => {
		// 7% drift (drift-threshold path, not purchases-blocked) so the rate limit would apply
		// if (incorrectly) lastRepriceAt got recorded despite the send failing.
		const chain = buildChain({ currentRef: refWithDrift(SPOT_REF, 700n) })
		const contracts = buildContracts(chain, { setReferencePrice: jest.fn().mockRejectedValue(new Error('rpc boom')) })
		const alerter = buildAlerter()
		const service = new RepriceService(buildConfig(), contracts, alerter, () => 1_000_000)

		await service.tick()
		expect(alerter.notify).toHaveBeenCalledWith(expect.stringContaining('failed'), expect.objectContaining({ error: 'rpc boom' }))

		// A second tick must still attempt a reprice: lastRepriceAt must not have been recorded
		// after the failed send, or this would be wrongly rate-limit-suppressed into an alert-only path.
		alerter.notify.mockClear()
		contracts.setReferencePrice.mockResolvedValue('0xhash2')
		await service.tick()
		expect(contracts.setReferencePrice).toHaveBeenCalledTimes(2)
	})

	it('persists lastRepriceAt across ticks and keeps repricing while purchases remain blocked', async () => {
		const chain = buildChain({ currentRef: refWithDrift(SPOT_REF, 2000n) })
		const contracts = buildContracts(chain)
		const alerter = buildAlerter()
		let time = 0
		const service = new RepriceService(buildConfig(), contracts, alerter, () => time)

		await service.tick() // reprices (purchases-blocked bypasses rate limit anyway)
		time = 1_000 // 1s later — well inside minRepriceIntervalMs
		await service.tick() // still purchases-blocked (chain state unchanged in this fake) -> reprices again
		expect(contracts.setReferencePrice).toHaveBeenCalledTimes(2)
	})

	it('processes remaining stables when one stable errors', async () => {
		const stableA: StableTarget = { symbol: 'USDT', address: '0xA', decimals: 6, pool: '0xPoolA' }
		// decimals matches SPOT_REF's fixture (6) — this test isolates per-stable error handling,
		// not the sqrtPriceX96ToRef conversion (covered separately in math.test.ts).
		const stableB: StableTarget = { symbol: 'KUSD', address: '0xB', decimals: 6, pool: '0xPoolB' }
		const chainB = buildChain({ currentRef: refWithDrift(SPOT_REF, 700n) })

		const contracts: jest.Mocked<IContractService> = {
			assertOperatorRole: jest.fn().mockResolvedValue(undefined),
			readStableState: jest.fn().mockImplementation((address: string) => {
				if (address === '0xA') return Promise.reject(new Error('pool unreachable'))
				return Promise.resolve(chainB)
			}),
			setReferencePrice: jest.fn().mockResolvedValue('0xhash'),
		}
		const alerter = buildAlerter()
		await new RepriceService(buildConfig({ stables: [stableA, stableB] }), contracts, alerter).tick()

		expect(alerter.notify).toHaveBeenCalledWith(expect.stringContaining('USDT'), expect.objectContaining({ error: 'pool unreachable' }))
		expect(contracts.setReferencePrice).toHaveBeenCalledWith('0xB', SPOT_REF)
	})
})
