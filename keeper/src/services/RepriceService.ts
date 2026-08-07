import { IContractService } from './ContractService'
import { Alerter } from '../utils/alert'
import { SampleWindow } from '../utils/SampleWindow'
import { sqrtPriceX96ToRef } from '../utils/math'
import { decideAction } from './decision'
import { KeeperConfig, StableTarget } from '../types'
import logger from '../utils/logger'

interface StableRuntime {
	stable: StableTarget
	window: SampleWindow
	lastRepriceAt: number | null
}

/**
 * Orchestrates one reprice check per configured stable per tick: reads on-chain state,
 * updates the smoothing window, asks decision.ts what (if anything) to do, and executes it.
 * All the actual policy is in decision.ts (pure) — this class is the impure wiring +
 * bookkeeping (rate-limit timestamps, alerting, dry-run/paused guards) around it.
 */
export class RepriceService {
	private readonly runtimes: StableRuntime[]

	constructor(
		private readonly config: KeeperConfig,
		private readonly contracts: IContractService,
		private readonly alerter: Alerter,
		private readonly now: () => number = Date.now
	) {
		this.runtimes = config.stables.map((stable) => ({
			stable,
			window: new SampleWindow(config.sampleWindow),
			lastRepriceAt: null,
		}))
	}

	/** Processes every configured stable once. A failure on one stable never blocks the others. */
	async tick(): Promise<void> {
		for (const runtime of this.runtimes) {
			try {
				await this.tickStable(runtime)
			} catch (err) {
				const message = (err as Error).message
				logger.error(`RepriceService: tick failed for ${runtime.stable.symbol}`, { error: message })
				await this.alerter.notify(`Reprice keeper tick failed for ${runtime.stable.symbol}`, { error: message })
			}
		}
	}

	private async tickStable(runtime: StableRuntime): Promise<void> {
		const { stable } = runtime
		const chain = await this.contracts.readStableState(stable.address, stable.pool)
		const instantSpotRef = sqrtPriceX96ToRef(chain.sqrtPriceX96, stable.decimals)
		runtime.window.push(instantSpotRef)
		const medianSpotRef = runtime.window.median()

		const action = decideAction({
			currentRef: chain.currentRef,
			instantSpotRef,
			medianSpotRef,
			slippageBpsOnChain: chain.slippageBps,
			maxRefDeviationBps: chain.maxRefDeviationBps,
			repriceThresholdBps: this.config.repriceThresholdBps,
			alertThresholdBps: this.config.alertThresholdBps,
			msSinceLastReprice: runtime.lastRepriceAt === null ? null : this.now() - runtime.lastRepriceAt,
			minRepriceIntervalMs: this.config.minRepriceIntervalMs,
		})

		logger.info(`${stable.symbol} checked`, {
			currentRef: chain.currentRef.toString(),
			instantSpotRef: instantSpotRef.toString(),
			medianSpotRef: medianSpotRef.toString(),
			action: action.kind,
		})

		if (action.kind === 'none') return

		if (action.kind === 'alert') {
			await this.alerter.notify(`${stable.symbol} reference price drift ${(Number(action.driftBps) / 100).toFixed(2)}%`, {
				stable: stable.symbol,
				reason: action.reason,
				driftBps: action.driftBps.toString(),
			})
			return
		}

		await this.executeReprice(runtime, chain.paused, action.targetRef, action.reason, action.driftBps)
	}

	private async executeReprice(
		runtime: StableRuntime,
		paused: boolean,
		targetRef: bigint,
		reason: string,
		driftBps: bigint
	): Promise<void> {
		const { stable } = runtime

		if (paused) {
			logger.warn(`${stable.symbol}: VaultManager is paused — skipping reprice`, { reason })
			await this.alerter.notify(`${stable.symbol} needs repricing but VaultManager is paused`, { reason })
			return
		}

		if (this.config.dryRun) {
			logger.info(`${stable.symbol}: DRY_RUN — would reprice`, { targetRef: targetRef.toString(), reason })
			return
		}

		try {
			const hash = await this.contracts.setReferencePrice(stable.address, targetRef)
			runtime.lastRepriceAt = this.now()
			logger.info(`${stable.symbol}: repriced`, { targetRef: targetRef.toString(), reason, hash })
			if (reason === 'purchases-blocked') {
				await this.alerter.notify(`${stable.symbol} purchases were blocked and have been auto-repriced`, {
					targetRef: targetRef.toString(),
					driftBps: driftBps.toString(),
					hash,
				})
			}
		} catch (err) {
			const message = (err as Error).message
			logger.error(`${stable.symbol}: setReferencePrice failed`, { error: message })
			await this.alerter.notify(`${stable.symbol} reprice transaction failed`, { reason, error: message })
		}
	}
}
