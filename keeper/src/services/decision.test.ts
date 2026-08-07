import { decideAction } from './decision'
import { DecisionInputs } from '../types'

const base: DecisionInputs = {
	currentRef: 1000n,
	instantSpotRef: 1000n,
	medianSpotRef: 1000n,
	slippageBpsOnChain: 1500n,
	maxRefDeviationBps: 4000n,
	repriceThresholdBps: 500n,
	alertThresholdBps: 1000n,
	msSinceLastReprice: null,
	minRepriceIntervalMs: 600_000,
}

describe('decideAction', () => {
	it('reprices immediately to instant spot when purchases are actively blocked, ignoring the rate limit', () => {
		const action = decideAction({
			...base,
			instantSpotRef: 1200n, // 20% drift, >= slippageBpsOnChain (15%)
			medianSpotRef: 1200n,
			msSinceLastReprice: 100, // well within the rate-limit window
		})
		expect(action).toEqual({ kind: 'reprice', targetRef: 1200n, reason: 'purchases-blocked', driftBps: 2000n })
	})

	it('treats instant drift exactly equal to slippageBpsOnChain as blocked', () => {
		const action = decideAction({ ...base, instantSpotRef: 1150n }) // exactly 15%
		expect(action.kind).toBe('reprice')
		expect((action as any).reason).toBe('purchases-blocked')
	})

	it('reprices to the smoothed median when drift crosses the threshold and is not rate-limited', () => {
		const action = decideAction({
			...base,
			instantSpotRef: 1080n, // 8% — below the 15% block line
			medianSpotRef: 1070n, // 7% — above the 5% reprice threshold
		})
		expect(action).toEqual({ kind: 'reprice', targetRef: 1070n, reason: 'drift-threshold', driftBps: 700n })
	})

	it('treats median drift exactly equal to the reprice threshold as actionable', () => {
		const action = decideAction({ ...base, instantSpotRef: 1010n, medianSpotRef: 1050n }) // exactly 5%
		expect(action.kind).toBe('reprice')
		expect((action as any).reason).toBe('drift-threshold')
	})

	it('clamps the reprice target to the on-chain max-deviation band', () => {
		const action = decideAction({
			...base,
			maxRefDeviationBps: 2000n, // 20% band
			instantSpotRef: 1010n,
			medianSpotRef: 1500n, // 50% drift — would be rejected on-chain if sent raw
		})
		expect(action).toEqual({ kind: 'reprice', targetRef: 1200n, reason: 'drift-threshold', driftBps: 5000n })
	})

	it('suppresses the threshold reprice when rate-limited, but still alerts if drift is elevated', () => {
		const action = decideAction({
			...base,
			instantSpotRef: 1120n, // 12% — below the 15% block line
			medianSpotRef: 1130n, // 13% — above reprice threshold, but rate limit blocks the send
			msSinceLastReprice: 1_000, // just repriced 1s ago, well inside the 10min window
		})
		expect(action).toEqual({ kind: 'alert', reason: 'drift-elevated', driftBps: 1300n })
	})

	it('does not rate-limit the purchases-blocked path even right after a reprice', () => {
		const action = decideAction({
			...base,
			instantSpotRef: 1200n,
			medianSpotRef: 1200n,
			msSinceLastReprice: 1,
		})
		expect(action.kind).toBe('reprice')
		expect((action as any).reason).toBe('purchases-blocked')
	})

	it('alerts without ever attempting a reprice when alertThreshold is configured below repriceThreshold', () => {
		const action = decideAction({
			...base,
			repriceThresholdBps: 500n,
			alertThresholdBps: 300n, // inverted from the typical default, but a valid config
			instantSpotRef: 1040n,
			medianSpotRef: 1040n, // 4% drift: below repriceThreshold(5%), above alertThreshold(3%)
		})
		expect(action).toEqual({ kind: 'alert', reason: 'drift-elevated', driftBps: 400n })
	})

	it('treats worst-drift exactly equal to the alert threshold as actionable', () => {
		const action = decideAction({
			...base,
			repriceThresholdBps: 9999n, // effectively disable the reprice path for this test
			instantSpotRef: 1100n,
			medianSpotRef: 1100n, // exactly 10% == alertThresholdBps
		})
		expect(action).toEqual({ kind: 'alert', reason: 'drift-elevated', driftBps: 1000n })
	})

	it('does nothing when drift is below every threshold', () => {
		const action = decideAction({ ...base, instantSpotRef: 1005n, medianSpotRef: 1003n })
		expect(action).toEqual({ kind: 'none' })
	})

	it('does nothing when refs exactly match', () => {
		expect(decideAction(base)).toEqual({ kind: 'none' })
	})
})
