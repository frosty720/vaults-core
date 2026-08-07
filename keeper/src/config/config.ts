import dotenv from 'dotenv'
import { KeeperConfig, StableTarget } from '../types'

dotenv.config()

// Mainnet (3888) default — USDT + KUSD against their VaultManager-configured V3 pools, as
// verified on-chain 2026-07-06 (vaults-core/scripts/deploy.config.ts NETWORKS[3888].stables).
// Override with STABLES_JSON for testnet or if the enabled-stable set changes.
const DEFAULT_STABLES: StableTarget[] = [
	{ symbol: 'USDT', address: '0x2CA775C77B922A51FcF3097F52bFFdbc0250D99A', decimals: 6, pool: '0x3848C7C8D088549194A264Cb1d639258AbE406a9' },
	{ symbol: 'KUSD', address: '0xCd02480926317748e95c5bBBbb7D1070b2327f1A', decimals: 18, pool: '0xf8c867c0f07eba68b2acf07b9ffd45b1aa1ddcfe' },
]

function parseBool(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined || value === '') return fallback
	return value.toLowerCase() === 'true'
}

function parseStables(json: string | undefined): StableTarget[] {
	if (!json) return DEFAULT_STABLES
	let parsed: unknown
	try {
		parsed = JSON.parse(json)
	} catch (err) {
		throw new Error(`STABLES_JSON is not valid JSON: ${(err as Error).message}`)
	}
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new Error('STABLES_JSON must be a non-empty array')
	}
	for (const s of parsed) {
		if (!s || typeof s.symbol !== 'string' || typeof s.address !== 'string' || typeof s.pool !== 'string' || typeof s.decimals !== 'number') {
			throw new Error('STABLES_JSON entries need string symbol/address/pool and numeric decimals')
		}
	}
	return parsed as StableTarget[]
}

/** Loads and validates keeper configuration. `env` is injectable for tests. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): KeeperConfig {
	const dryRun = parseBool(env.DRY_RUN, false)

	if (!dryRun && !env.KEEPER_PK) {
		throw new Error('Missing required environment variable: KEEPER_PK (or set DRY_RUN=true)')
	}
	if (!env.VAULT_MANAGER) {
		throw new Error('Missing required environment variable: VAULT_MANAGER')
	}

	return {
		rpcUrl: env.RPC_URL || 'https://rpc.kalychain.io/rpc',
		chainId: parseInt(env.CHAIN_ID || '3888', 10),
		keeperPk: env.KEEPER_PK || '',
		vaultManager: env.VAULT_MANAGER,
		stables: parseStables(env.STABLES_JSON),
		checkIntervalMs: parseInt(env.CHECK_INTERVAL_MS || '60000', 10),
		sampleWindow: parseInt(env.SAMPLE_WINDOW || '15', 10),
		repriceThresholdBps: BigInt(env.REPRICE_THRESHOLD_BPS || '500'),
		alertThresholdBps: BigInt(env.ALERT_THRESHOLD_BPS || '1000'),
		minRepriceIntervalMs: parseInt(env.MIN_REPRICE_INTERVAL_MS || '600000', 10),
		gasLimit: BigInt(env.GAS_LIMIT || '200000'),
		dryRun,
		alertWebhookUrl: env.ALERT_WEBHOOK_URL || null,
	}
}
