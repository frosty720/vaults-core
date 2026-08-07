import { median } from './math'

/**
 * Fixed-size rolling window of spot-price samples, one per stable. Backs the median
 * smoothing that keeps a single-block price wick from dragging referencePrice with it —
 * see docs/REPRICE_KEEPER_HANDOFF.md "Manipulation guard".
 */
export class SampleWindow {
	private samples: bigint[] = []

	constructor(private readonly maxSize: number) {
		if (maxSize < 1) throw new Error('SampleWindow: maxSize must be at least 1')
	}

	push(value: bigint): void {
		this.samples.push(value)
		if (this.samples.length > this.maxSize) this.samples.shift()
	}

	median(): bigint {
		return median(this.samples)
	}

	get size(): number {
		return this.samples.length
	}

	get isFull(): boolean {
		return this.samples.length >= this.maxSize
	}
}
