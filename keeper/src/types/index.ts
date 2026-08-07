export interface StableTarget {
	symbol: string
	address: string
	decimals: number
	pool: string
}

export interface KeeperConfig {
	rpcUrl: string
	chainId: number
	keeperPk: string
	vaultManager: string
	stables: StableTarget[]
	checkIntervalMs: number
	sampleWindow: number
	repriceThresholdBps: bigint
	alertThresholdBps: bigint
	minRepriceIntervalMs: number
	gasLimit: bigint
	dryRun: boolean
	alertWebhookUrl: string | null
}

export type Action =
	| { kind: 'none' }
	| { kind: 'alert'; reason: string; driftBps: bigint }
	| { kind: 'reprice'; targetRef: bigint; reason: string; driftBps: bigint }

export interface DecisionInputs {
	currentRef: bigint
	instantSpotRef: bigint
	medianSpotRef: bigint
	slippageBpsOnChain: bigint
	maxRefDeviationBps: bigint
	repriceThresholdBps: bigint
	alertThresholdBps: bigint
	msSinceLastReprice: number | null
	minRepriceIntervalMs: number
}

export interface StableChainState {
	sqrtPriceX96: bigint
	currentRef: bigint
	slippageBps: bigint
	maxRefDeviationBps: bigint
	paused: boolean
}
