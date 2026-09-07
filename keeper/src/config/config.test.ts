import { loadConfig } from './config'

const validEnv = {
	KEEPER_PK: '0xabc123',
	VAULT_MANAGER: '0x8ad3ad4a3f20672d39f6f87d6bdf1df5386ac6a5',
}

describe('loadConfig', () => {
	it('throws when KEEPER_PK is missing and DRY_RUN is not set', () => {
		expect(() => loadConfig({ VAULT_MANAGER: validEnv.VAULT_MANAGER })).toThrow('KEEPER_PK')
	})

	it('allows a missing KEEPER_PK when DRY_RUN=true', () => {
		const cfg = loadConfig({ VAULT_MANAGER: validEnv.VAULT_MANAGER, DRY_RUN: 'true' })
		expect(cfg.dryRun).toBe(true)
		expect(cfg.keeperPk).toBe('')
	})

	it('throws when VAULT_MANAGER is missing', () => {
		expect(() => loadConfig({ KEEPER_PK: validEnv.KEEPER_PK })).toThrow('VAULT_MANAGER')
	})

	it('applies defaults when optional vars are unset', () => {
		const cfg = loadConfig(validEnv)
		expect(cfg.rpcUrl).toBe('https://rpc.kalychain.io/rpc')
		expect(cfg.chainId).toBe(3888)
		expect(cfg.checkIntervalMs).toBe(60_000)
		expect(cfg.sampleWindow).toBe(15)
		expect(cfg.repriceThresholdBps).toBe(500n)
		expect(cfg.alertThresholdBps).toBe(1000n)
		expect(cfg.minRepriceIntervalMs).toBe(600_000)
		expect(cfg.gasLimit).toBe(200_000n)
		expect(cfg.dryRun).toBe(false)
		expect(cfg.alertWebhookUrl).toBeNull()
		expect(cfg.stables).toHaveLength(3)
		expect(cfg.stables.map((s) => s.symbol)).toEqual(['USDT', 'KUSD', 'USDC'])
	})

	it('overrides defaults from env', () => {
		const cfg = loadConfig({
			...validEnv,
			RPC_URL: 'https://testnetrpc.kalychain.io/rpc',
			CHAIN_ID: '3889',
			CHECK_INTERVAL_MS: '30000',
			REPRICE_THRESHOLD_BPS: '300',
			ALERT_WEBHOOK_URL: 'https://example.com/hook',
		})
		expect(cfg.rpcUrl).toBe('https://testnetrpc.kalychain.io/rpc')
		expect(cfg.chainId).toBe(3889)
		expect(cfg.checkIntervalMs).toBe(30_000)
		expect(cfg.repriceThresholdBps).toBe(300n)
		expect(cfg.alertWebhookUrl).toBe('https://example.com/hook')
	})

	it('parses a valid STABLES_JSON override', () => {
		const stables = [{ symbol: 'DAI', address: '0x1111111111111111111111111111111111111111', decimals: 18, pool: '0x2222222222222222222222222222222222222222' }]
		const cfg = loadConfig({ ...validEnv, STABLES_JSON: JSON.stringify(stables) })
		expect(cfg.stables).toEqual(stables)
	})

	it('rejects malformed STABLES_JSON', () => {
		expect(() => loadConfig({ ...validEnv, STABLES_JSON: '{not json' })).toThrow('not valid JSON')
	})

	it('rejects an empty STABLES_JSON array', () => {
		expect(() => loadConfig({ ...validEnv, STABLES_JSON: '[]' })).toThrow('non-empty array')
	})

	it('rejects STABLES_JSON entries missing required fields', () => {
		expect(() => loadConfig({ ...validEnv, STABLES_JSON: '[{"symbol":"DAI"}]' })).toThrow('symbol/address/pool')
	})
})
