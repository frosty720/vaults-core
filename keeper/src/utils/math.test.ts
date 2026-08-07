import { sqrtPriceX96ToRef, driftBps, median, clampToBand } from './math'

describe('sqrtPriceX96ToRef', () => {
	it('matches the real USDT pool observed during the 2026-07-06 incident', () => {
		// WKLC/USDT pool 0x3848...06a9 at the block the failed $1000 purchase was mined.
		expect(sqrtPriceX96ToRef(3489516281201909751505n, 6)).toBe(515500047378104247758n)
	})

	it('matches the real KUSD pool observed during the 2026-07-06 incident', () => {
		expect(sqrtPriceX96ToRef(4332261802345473246433335324n, 18)).toBe(334448906550649718373n)
	})

	it('rejects a non-positive sqrtPriceX96', () => {
		expect(() => sqrtPriceX96ToRef(0n, 6)).toThrow('must be positive')
		expect(() => sqrtPriceX96ToRef(-1n, 6)).toThrow('must be positive')
	})

	it('rejects out-of-range decimals', () => {
		expect(() => sqrtPriceX96ToRef(3489516281201909751505n, 19)).toThrow('out of range')
		expect(() => sqrtPriceX96ToRef(3489516281201909751505n, -1)).toThrow('out of range')
	})
})

describe('driftBps', () => {
	it('matches the observed USDT drift (ref stale vs spot) from the incident', () => {
		expect(driftBps(515500047378104247758n, 390282523019782824212n)).toBe(3208n)
	})

	it('matches the observed KUSD drift from the incident', () => {
		expect(driftBps(334448906550649718373n, 389626804942188016373n)).toBe(1416n)
	})

	it('is symmetric regardless of which side is higher', () => {
		expect(driftBps(120n, 100n)).toBe(2000n)
		expect(driftBps(80n, 100n)).toBe(2000n)
	})

	it('is zero when value equals reference', () => {
		expect(driftBps(100n, 100n)).toBe(0n)
	})

	it('rejects a non-positive reference', () => {
		expect(() => driftBps(100n, 0n)).toThrow('must be positive')
	})
})

describe('median', () => {
	it('returns the middle value for an odd-length array', () => {
		expect(median([1n, 5n, 3n])).toBe(3n)
	})

	it('averages the two middle values for an even-length array', () => {
		expect(median([1n, 2n, 3n, 4n])).toBe(2n)
	})

	it('is order-independent', () => {
		expect(median([5n, 1n, 3n, 2n, 4n])).toBe(3n)
	})

	it('handles a single-element array', () => {
		expect(median([42n])).toBe(42n)
	})

	it('handles duplicate values (exercises the equal-elements sort branch)', () => {
		expect(median([2n, 2n, 2n])).toBe(2n)
	})

	it('rejects an empty array', () => {
		expect(() => median([])).toThrow('must not be empty')
	})
})

describe('clampToBand', () => {
	it('clamps a target above the upper bound', () => {
		expect(clampToBand(100n, 200n, 4000n)).toBe(140n)
	})

	it('clamps a target below the lower bound', () => {
		expect(clampToBand(100n, 50n, 4000n)).toBe(60n)
	})

	it('passes through a target inside the band unchanged', () => {
		expect(clampToBand(100n, 110n, 4000n)).toBe(110n)
	})

	it('rejects a non-positive current value', () => {
		expect(() => clampToBand(0n, 50n, 4000n)).toThrow('must be positive')
	})
})
