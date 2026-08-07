const Q192 = 2n ** 192n
const BPS_DENOMINATOR = 10_000n

/**
 * Converts a Uniswap V3 pool's sqrtPriceX96 (token0=WKLC 18-dec, token1=stable) into
 * referencePrice units: KLC-wei (1e18) per $1 of the stable. Mirrors VaultManager's
 * accounting so the keeper's notion of "spot" matches what the contract compares against.
 */
export function sqrtPriceX96ToRef(sqrtPriceX96: bigint, stableDecimals: number): bigint {
	if (sqrtPriceX96 <= 0n) throw new Error('sqrtPriceX96ToRef: sqrtPriceX96 must be positive')
	if (stableDecimals < 0 || stableDecimals > 18) throw new Error('sqrtPriceX96ToRef: stableDecimals out of range')
	return (Q192 * 10n ** BigInt(stableDecimals)) / (sqrtPriceX96 * sqrtPriceX96)
}

/** Absolute drift of `value` from `reference`, in bps (10_000 = 100%). */
export function driftBps(value: bigint, reference: bigint): bigint {
	if (reference <= 0n) throw new Error('driftBps: reference must be positive')
	const diff = value > reference ? value - reference : reference - value
	return (diff * BPS_DENOMINATOR) / reference
}

/** Median of a bigint array (average of the two middle values when even-length). */
export function median(values: bigint[]): bigint {
	if (values.length === 0) throw new Error('median: values must not be empty')
	const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2n
}

/**
 * Clamps `target` to within `maxDeviationBps` of `current` — mirrors VaultManager's
 * on-chain `setReferencePrice` band so the keeper never sends a tx doomed to revert
 * `VM: ref price out of band`.
 */
export function clampToBand(current: bigint, target: bigint, maxDeviationBps: bigint): bigint {
	if (current <= 0n) throw new Error('clampToBand: current must be positive')
	const maxUp = current + (current * maxDeviationBps) / BPS_DENOMINATOR
	const maxDown = current - (current * maxDeviationBps) / BPS_DENOMINATOR
	if (target > maxUp) return maxUp
	if (target < maxDown) return maxDown
	return target
}
