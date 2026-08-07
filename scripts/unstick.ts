import { ethers } from 'hardhat'

/**
 * Clear stuck/pending transactions for the signer by replacing every nonce in the
 * gap [latest, pending) with a 0-value self-transfer at a proper legacy gas price.
 *
 * Why this is needed: KalyChain (Besu) reports baseFee ~7 wei and a 0 priority fee,
 * so wallets/SDKs that build EIP-1559 txs from those values produce maxFeePerGas
 * far below the node's effective minimum (~1000 wei). Those txs enter the mempool
 * but never mine, and they BLOCK every later nonce. Replacing them with a
 * higher-priced legacy tx at the same nonce unblocks the account.
 *
 * The signer must be the stuck account. Put its key in DEPLOYER_PK (or OPERATOR_PK)
 * in .env — the same key you used for migrate-pol.
 *
 *   npx hardhat run scripts/unstick.ts --network testnet
 *
 * Optional: GAS_GWEI overrides the replacement gas price (default 5 gwei).
 */

async function main() {
	const [signer] = await ethers.getSigners()
	if (!signer) throw new Error('No signer — set DEPLOYER_PK (or OPERATOR_PK) in .env')

	const addr = await signer.getAddress()
	const provider = ethers.provider
	const latest = await provider.getTransactionCount(addr, 'latest')
	const pending = await provider.getTransactionCount(addr, 'pending')

	const gwei = process.env.GAS_GWEI ?? '5'
	const gasPrice = ethers.parseUnits(gwei, 'gwei')

	console.log('Account        :', addr)
	console.log('Latest nonce   :', latest)
	console.log('Pending nonce  :', pending)
	console.log('Replacement gas:', gwei, 'gwei')

	if (pending <= latest) {
		console.log('\nNo stuck transactions. Nothing to do.')
		return
	}

	for (let nonce = latest; nonce < pending; nonce++) {
		// Re-check the on-chain nonce each round: replacing one stuck tx can let the
		// next one mine on its own, which would make our replacement "nonce too low".
		const current = await provider.getTransactionCount(addr, 'latest')
		if (nonce < current) {
			console.log(`\nNonce ${nonce} already mined — skipping.`)
			continue
		}
		console.log(`\nReplacing nonce ${nonce} with a 0-value self-transfer...`)
		try {
			const tx = await signer.sendTransaction({ to: addr, value: 0n, nonce, gasPrice, gasLimit: 21000n })
			console.log('  tx:', tx.hash)
			await tx.wait()
			console.log('  confirmed.')
		} catch (e) {
			const msg = (e as Error).message || ''
			if (msg.toLowerCase().includes('nonce too low')) {
				console.log(`  nonce ${nonce} already consumed — skipping.`)
				continue
			}
			throw e
		}
	}

	console.log('\nDone. The account is unblocked — retry your approval in the dApp.')
}

main().catch((e) => {
	console.error(e)
	process.exitCode = 1
})
