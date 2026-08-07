import { driftBps, clampToBand } from '../utils/math'
import { Action, DecisionInputs } from '../types'

/**
 * Decides what, if anything, to do about one stable's reference price this tick.
 *
 * Priority order:
 *  1. Purchases are ACTIVELY BLOCKED right now (instant drift already past the contract's
 *     own slippageBps) — reprice immediately to instant spot, bypassing the smoothing
 *     window and the rate limit. Nothing is gained by waiting when buys are already reverting.
 *  2. Smoothed drift (median over the sample window) has crossed the reprice threshold and
 *     we're not rate-limited — reprice to the median (resistant to a single-block wick).
 *  3. Drift is elevated but not yet actionable — alert only.
 *  4. Otherwise — do nothing.
 *
 * Every reprice target is clamped to the on-chain ±maxRefDeviationBps band so a computed
 * target can never produce a transaction that reverts 'VM: ref price out of band'.
 */
export function decideAction(inputs: DecisionInputs): Action {
	const instantDrift = driftBps(inputs.instantSpotRef, inputs.currentRef)
	const medianDrift = driftBps(inputs.medianSpotRef, inputs.currentRef)

	const purchasesBlocked = instantDrift >= inputs.slippageBpsOnChain
	if (purchasesBlocked) {
		const targetRef = clampToBand(inputs.currentRef, inputs.instantSpotRef, inputs.maxRefDeviationBps)
		return { kind: 'reprice', targetRef, reason: 'purchases-blocked', driftBps: instantDrift }
	}

	const rateLimited =
		inputs.msSinceLastReprice !== null && inputs.msSinceLastReprice < inputs.minRepriceIntervalMs
	if (medianDrift >= inputs.repriceThresholdBps && !rateLimited) {
		const targetRef = clampToBand(inputs.currentRef, inputs.medianSpotRef, inputs.maxRefDeviationBps)
		return { kind: 'reprice', targetRef, reason: 'drift-threshold', driftBps: medianDrift }
	}

	const worstDrift = medianDrift > instantDrift ? medianDrift : instantDrift
	if (worstDrift >= inputs.alertThresholdBps) {
		return { kind: 'alert', reason: 'drift-elevated', driftBps: worstDrift }
	}

	return { kind: 'none' }
}
