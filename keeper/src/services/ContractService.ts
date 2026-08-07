import { ethers } from 'ethers'
import { KeeperConfig, StableChainState } from '../types'
import logger from '../utils/logger'

const VAULT_MANAGER_ABI = [
	'function referencePrice(address stable) view returns (uint256)',
	'function setReferencePrice(address stable, uint256 price) external',
	'function slippageBps() view returns (uint16)',
	'function maxRefPriceDeviationBps() view returns (uint16)',
	'function paused() view returns (bool)',
	'function hasRole(bytes32 role, address account) view returns (bool)',
	'function OPERATOR_ROLE() view returns (bytes32)',
]

const POOL_ABI = [
	'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
]

/** Thin ethers wiring; the reprice decision logic lives in RepriceService/decision.ts. */
export interface IContractService {
	assertOperatorRole(): Promise<void>
	readStableState(stableAddress: string, poolAddress: string): Promise<StableChainState>
	setReferencePrice(stableAddress: string, newRef: bigint): Promise<string>
}

export class ContractService implements IContractService {
	private readonly provider: ethers.JsonRpcProvider
	private readonly signer: ethers.Wallet | null
	private readonly vaultManager: ethers.Contract
	private readonly poolContracts = new Map<string, ethers.Contract>()

	constructor(private readonly config: KeeperConfig) {
		this.provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId)
		this.signer = config.keeperPk ? new ethers.Wallet(config.keeperPk, this.provider) : null
		this.vaultManager = new ethers.Contract(config.vaultManager, VAULT_MANAGER_ABI, this.signer ?? this.provider)
	}

	private poolContract(pool: string): ethers.Contract {
		let c = this.poolContracts.get(pool)
		if (!c) {
			c = new ethers.Contract(pool, POOL_ABI, this.provider)
			this.poolContracts.set(pool, c)
		}
		return c
	}

	async assertOperatorRole(): Promise<void> {
		if (!this.signer) return // DRY_RUN with no key configured — nothing will be sent anyway
		const role: string = await this.vaultManager.OPERATOR_ROLE()
		const granted: boolean = await this.vaultManager.hasRole(role, this.signer.address)
		if (!granted) {
			throw new Error(`Keeper wallet ${this.signer.address} does not hold OPERATOR_ROLE on ${this.config.vaultManager}`)
		}
	}

	async readStableState(stableAddress: string, poolAddress: string): Promise<StableChainState> {
		const [slot0, currentRef, slippageBps, maxRefDeviationBps, paused] = await Promise.all([
			this.poolContract(poolAddress).slot0(),
			this.vaultManager.referencePrice(stableAddress),
			this.vaultManager.slippageBps(),
			this.vaultManager.maxRefPriceDeviationBps(),
			this.vaultManager.paused(),
		])
		return {
			sqrtPriceX96: BigInt(slot0[0]),
			currentRef: BigInt(currentRef),
			slippageBps: BigInt(slippageBps),
			maxRefDeviationBps: BigInt(maxRefDeviationBps),
			paused: Boolean(paused),
		}
	}

	async setReferencePrice(stableAddress: string, newRef: bigint): Promise<string> {
		if (!this.signer) throw new Error('setReferencePrice: no signer configured (DRY_RUN or missing KEEPER_PK)')
		const tx = await this.vaultManager.setReferencePrice(stableAddress, newRef, { gasLimit: this.config.gasLimit })
		logger.info('setReferencePrice tx sent', { stable: stableAddress, newRef: newRef.toString(), hash: tx.hash })
		const receipt = await tx.wait()
		return receipt.hash
	}
}
