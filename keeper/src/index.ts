import { loadConfig } from './config/config'
import { ContractService } from './services/ContractService'
import { RepriceService } from './services/RepriceService'
import { createAlerter } from './utils/alert'
import logger from './utils/logger'

async function main(): Promise<void> {
	const config = loadConfig()
	logger.info('vault-reprice-keeper starting', {
		chainId: config.chainId,
		vaultManager: config.vaultManager,
		stables: config.stables.map((s) => s.symbol),
		dryRun: config.dryRun,
		checkIntervalMs: config.checkIntervalMs,
	})

	const contracts = new ContractService(config)
	await contracts.assertOperatorRole() // fail fast if the keeper wallet can't actually reprice

	const alerter = createAlerter(config.alertWebhookUrl)
	const service = new RepriceService(config, contracts, alerter)

	let stopped = false
	const runTick = async () => {
		if (stopped) return
		await service.tick()
	}

	await runTick()
	const interval = setInterval(runTick, config.checkIntervalMs)

	const shutdown = (signal: string) => {
		logger.info(`vault-reprice-keeper received ${signal}, shutting down`)
		stopped = true
		clearInterval(interval)
		process.exit(0)
	}
	process.on('SIGINT', () => shutdown('SIGINT'))
	process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
	logger.error('vault-reprice-keeper failed to start', { error: (err as Error).message })
	process.exit(1)
})
