import { SampleWindow } from './SampleWindow'

describe('SampleWindow', () => {
	it('rejects a maxSize below 1', () => {
		expect(() => new SampleWindow(0)).toThrow('at least 1')
	})

	it('reports size and isFull as samples accumulate', () => {
		const w = new SampleWindow(3)
		expect(w.size).toBe(0)
		expect(w.isFull).toBe(false)
		w.push(1n)
		w.push(2n)
		expect(w.isFull).toBe(false)
		w.push(3n)
		expect(w.size).toBe(3)
		expect(w.isFull).toBe(true)
	})

	it('evicts the oldest sample once maxSize is exceeded', () => {
		const w = new SampleWindow(3)
		w.push(10n)
		w.push(20n)
		w.push(30n)
		w.push(40n) // evicts 10n
		expect(w.size).toBe(3)
		expect(w.median()).toBe(30n) // [20,30,40]
	})

	it('computes the median over the current window', () => {
		const w = new SampleWindow(5)
		;[1n, 2n, 3n, 4n, 5n].forEach((v) => w.push(v))
		expect(w.median()).toBe(3n)
	})
})
