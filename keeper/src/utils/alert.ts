import logger from './logger'

export interface Alerter {
	notify(message: string, meta?: Record<string, unknown>): Promise<void>
}

/** Always-on fallback — nothing is silently lost even with no webhook configured. */
export class ConsoleAlerter implements Alerter {
	async notify(message: string, meta: Record<string, unknown> = {}): Promise<void> {
		logger.warn(`ALERT: ${message}`, meta)
	}
}

/**
 * Generic JSON POST to any webhook. The `text` field is Slack/Discord incoming-webhook
 * compatible; the full payload (message + meta) is included for a custom receiver.
 * Never throws — a broken alert channel must not crash the keeper's reprice loop.
 */
export class WebhookAlerter implements Alerter {
	constructor(
		private readonly url: string,
		private readonly fetchFn: typeof fetch = fetch
	) {}

	async notify(message: string, meta: Record<string, unknown> = {}): Promise<void> {
		try {
			const res = await this.fetchFn(this.url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: message, ...meta }),
			})
			if (!res.ok) logger.error(`WebhookAlerter: webhook returned ${res.status}`, { message })
		} catch (err) {
			logger.error('WebhookAlerter: failed to send webhook', { message, error: (err as Error).message })
		}
	}
}

export class CompositeAlerter implements Alerter {
	constructor(private readonly alerters: Alerter[]) {}

	async notify(message: string, meta?: Record<string, unknown>): Promise<void> {
		await Promise.all(this.alerters.map((a) => a.notify(message, meta)))
	}
}

/** Console alerting is always included; a webhook is layered in when configured. */
export function createAlerter(webhookUrl: string | null): Alerter {
	const alerters: Alerter[] = [new ConsoleAlerter()]
	if (webhookUrl) alerters.push(new WebhookAlerter(webhookUrl))
	return new CompositeAlerter(alerters)
}
