import { ethers } from 'hardhat'

/**
 * Operator action: raise the in-purchase swap slippage tolerance so vault buys can
 * succeed on the thinly-seeded testnet pools.
 *
 * Why: _deployPol swaps half the POL stable into WKLC with a minOut floor derived
 * from referencePrice and slippageBps. On testnet the pools are small (~$2.8k each)
 * and their spot price has drifted ~3% below referencePrice, so even a Light buy's
 * swap lands below the 3% (300 bps) minOut and reverts with "Too little received".
 * Raising slippageBps gives the swap room to fill. (maxSlippageBps caps this at 1000.)
 *
 * The signer must hold OPERATOR_ROLE (testnet operator = 0x3765Db2f…). Put that key
 * in OPERATOR_PK (or DEPLOYER_PK) in .env — the script auto-selects the matching one.
 *
 *   npx hardhat run scripts/set-slippage.ts --network testnet           # sets 1000 (10%)
 *   SLIPPAGE_BPS=800 npx hardhat run scripts/set-slippage.ts --network testnet
 *
 * NOTE: large tiers (Validator+) swap a big fraction of the small testnet pools and
 * will still revert from price impact alone — they need deeper pools, not more slippage.
 */

const VM_ABI = [
	'function OPERATOR_ROLE() view returns (bytes32)',
	'function hasRole(bytes32,address) view returns (bool)',
	'function slippageBps() view returns (uint16)',
	'function maxSlippageBps() view returns (uint16)',
	'function setSlippageBps(uint16 bps)',
]

async function main() {
	;(ethers.provider as any).estimateGas = async () => 200_000n
	;(ethers.provider as any).getFeeData = async () => new ethers.FeeData(5_000_000_000n, null, null)

	const vmAddr = process.env.VAULT_MANAGER
	if (!vmAddr) throw new Error('missing VAULT_MANAGER env var')
	const target = Number(process.env.SLIPPAGE_BPS ?? 1000)

	const vmRead = new ethers.Contract(vmAddr, VM_ABI, ethers.provider)
	const role: string = await vmRead.OPERATOR_ROLE()
	const current = await vmRead.slippageBps()
	const max = await vmRead.maxSlippageBps()
	console.log('VaultManager   :', vmAddr)
	console.log('slippageBps now:', Number(current), ' max allowed:', Number(max))
	console.log('target         :', target)

	if (target > Number(max)) throw new Error(`SLIPPAGE_BPS ${target} exceeds maxSlippageBps ${max}`)

	const signers = await ethers.getSigners()
	let operator = null
	for (const s of signers) {
		if (await vmRead.hasRole(role, s.address)) {
			operator = s
			break
		}
	}
	if (!operator) {
		throw new Error(
			'None of the configured signers hold OPERATOR_ROLE. Put the operator key ' +
				'(testnet: 0x3765Db2f21382240A8eF5f5E5690A6958f473D27) in OPERATOR_PK or DEPLOYER_PK in .env.',
		)
	}
	console.log('Operator signer:', operator.address)

	const vm = new ethers.Contract(vmAddr, VM_ABI, operator)
	const tx = await vm.setSlippageBps(target)
	console.log('tx:', tx.hash)
	await tx.wait()
	console.log('Done. slippageBps =', target, '— retry a Light vault purchase in the dApp.')
}

main().catch((e) => {
	console.error(e)
	process.exitCode = 1
})
