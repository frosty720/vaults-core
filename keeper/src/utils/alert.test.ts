import logger from './logger'
import { ConsoleAlerter, WebhookAlerter, CompositeAlerter, createAlerter } from './alert'

jest.mock('./logger', () => ({
	__esModule: true,
	default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}))

describe('ConsoleAlerter', () => {
	it('logs a warning with the message and meta', async () => {
		await new ConsoleAlerter().notify('drift high', { driftBps: 1200n })
		expect(logger.warn).toHaveBeenCalledWith('ALERT: drift high', { driftBps: 1200n })
	})
})

describe('WebhookAlerter', () => {
	it('POSTs a Slack-compatible JSON body to the configured URL', async () => {
		const fetchFn = jest.fn().mockResolvedValue({ ok: true, status: 200 })
		await new WebhookAlerter('https://example.com/hook', fetchFn as any).notify('drift high', { driftBps: 1200n.toString() })

		expect(fetchFn).toHaveBeenCalledWith('https://example.com/hook', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: 'drift high', driftBps: '1200' }),
		})
	})

	it('logs an error but does not throw when the webhook responds non-ok', async () => {
		const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 500 })
		await expect(new WebhookAlerter('https://example.com/hook', fetchFn as any).notify('x')).resolves.toBeUndefined()
		expect(logger.error).toHaveBeenCalledWith('WebhookAlerter: webhook returned 500', { message: 'x' })
	})

	it('logs an error but does not throw when fetch itself rejects', async () => {
		const fetchFn = jest.fn().mockRejectedValue(new Error('network down'))
		await expect(new WebhookAlerter('https://example.com/hook', fetchFn as any).notify('x')).resolves.toBeUndefined()
		expect(logger.error).toHaveBeenCalledWith('WebhookAlerter: failed to send webhook', { message: 'x', error: 'network down' })
	})
})

describe('CompositeAlerter', () => {
	it('notifies every wrapped alerter', async () => {
		const a = { notify: jest.fn().mockResolvedValue(undefined) }
		const b = { notify: jest.fn().mockResolvedValue(undefined) }
		await new CompositeAlerter([a, b]).notify('msg', { foo: 1 })
		expect(a.notify).toHaveBeenCalledWith('msg', { foo: 1 })
		expect(b.notify).toHaveBeenCalledWith('msg', { foo: 1 })
	})
})

describe('createAlerter', () => {
	it('returns console-only alerting when no webhook is configured', async () => {
		await createAlerter(null).notify('msg')
		expect(logger.warn).toHaveBeenCalledWith('ALERT: msg', {})
	})

	it('layers a webhook alerter in when a URL is configured', () => {
		const alerter = createAlerter('https://example.com/hook') as CompositeAlerter
		expect((alerter as any).alerters).toHaveLength(2)
	})
})
