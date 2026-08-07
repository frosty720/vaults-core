import { ethers } from 'hardhat'

/**
 * Migrate POL (Protocol-Owned Liquidity) NFT positions from a previous treasury
 * to the CURRENT treasury configured in the VaultManager (the DAO treasury after
 * the Phase-2 handoff).
 *
 * Why this exists: on testnet, vaults were purchased BEFORE setTreasury() pointed
 * POL at the DAO. Those V3 position NFTs were minted to the old treasury address,
 * so the dApp (which values only liquidity held by the current treasury) shows $0
 * live POL even though ~$364 was deployed. Moving the NFTs to the DAO treasury
 * makes the on-chain ownership match the live config, and the dApp lights up.
 *
 * Fully self-configuring:
 *   - destination treasury  = VaultManager.treasury()      (current / DAO)
 *   - position manager      = VaultManager.positionManager()
 *   - position ids          = from PolDeployed event logs
 *
 * The signer MUST be the address that currently owns the positions (the old
 * treasury). Put that key in DEPLOYER_PK or OPERATOR_PK in .env. The script finds
 * the matching signer automatically and errors clearly if none is configured.
 *
 * Safety: dry-run by default. Set EXECUTE=1 to actually send the transfers.
 *
 *   npx hardhat run scripts/migrate-pol.ts --network testnet            # preview
 *   EXECUTE=1 npx hardhat run scripts/migrate-pol.ts --network testnet  # transfer
 */

// VaultManager deploy block (approx) — POL events can't predate the contract.
const DEPLOY_BLOCK = Number(process.env.DEPLOY_BLOCK ?? 47_800_000)
const LOG_CHUNK = 50_000 // Besu caps getLogs ranges; scan in chunks.

const VM_ABI = [
	'function treasury() view returns (address)',
	'function positionManager() view returns (address)',
	'event PolDeployed(address indexed stable, uint256 swapped, uint256 wklcOut, uint256 positionId)',
]
const NPM_ABI = [
	'function ownerOf(uint256 tokenId) view returns (address)',
	'function safeTransferFrom(address from, address to, uint256 tokenId)',
]

async function main() {
	// KalyChain (Besu) errors on eth_estimateGas; pin gas + legacy fee data.
	;(ethers.provider as any).estimateGas = async () => 1_000_000n
	;(ethers.provider as any).getFeeData = async () => new ethers.FeeData(21_000_000_000n, null, null)

	const vmAddr = process.env.VAULT_MANAGER
	if (!vmAddr) throw new Error('missing VAULT_MANAGER env var')

	const execute = process.env.EXECUTE === '1'
	const vm = new ethers.Contract(vmAddr, VM_ABI, ethers.provider)

	const treasury: string = await vm.treasury()
	const npmAddr: string = await vm.positionManager()
	console.log('VaultManager      :', vmAddr)
	console.log('Destination (DAO) :', treasury)
	console.log('PositionManager   :', npmAddr)
	console.log('Mode              :', execute ? 'EXECUTE (will send txs)' : 'DRY RUN (no txs)')

	// Collect all PolDeployed position ids from event logs (chunked).
	const latest = await ethers.provider.getBlockNumber()
	const ids: bigint[] = []
	for (let from = DEPLOY_BLOCK; from <= latest; from += LOG_CHUNK) {
		const to = Math.min(from + LOG_CHUNK - 1, latest)
		const logs = await vm.queryFilter(vm.filters.PolDeployed(), from, to)
		for (const l of logs) ids.push((l as any).args.positionId as bigint)
	}
	console.log(`\nFound ${ids.length} PolDeployed position(s): [${ids.join(', ')}]`)
	if (ids.length === 0) {
		console.log('Nothing to migrate.')
		return
	}

	const npm = new ethers.Contract(npmAddr, NPM_ABI, ethers.provider)
	const signers = await ethers.getSigners()

	// Bucket positions by current owner.
	const toMove: bigint[] = []
	const alreadyDao: bigint[] = []
	const ownerByOther = new Map<string, bigint[]>()
	let ownerOfPositions: string | null = null

	for (const id of ids) {
		let owner: string
		try {
			owner = await npm.ownerOf(id)
		} catch {
			console.log(`  position ${id}: ownerOf reverted (burned/withdrawn) — skipping`)
			continue
		}
		if (owner.toLowerCase() === treasury.toLowerCase()) {
			alreadyDao.push(id)
		} else {
			toMove.push(id)
			ownerOfPositions = owner
			const k = owner.toLowerCase()
			ownerByOther.set(k, [...(ownerByOther.get(k) ?? []), id])
		}
	}

	console.log(`\nAlready at DAO treasury : [${alreadyDao.join(', ') || '—'}]`)
	for (const [owner, list] of ownerByOther) console.log(`Held by ${owner} : [${list.join(', ')}]`)

	if (toMove.length === 0) {
		console.log('\nAll POL positions already owned by the DAO treasury. Nothing to do.')
		return
	}

	// Find the configured signer that owns the positions to move.
	const signer = signers.find((s) => s.address.toLowerCase() === ownerOfPositions!.toLowerCase())

	if (!execute) {
		console.log(`\nDRY RUN — would transfer [${toMove.join(', ')}] -> ${treasury}`)
		console.log(
			signer
				? `Signer for ${ownerOfPositions} is configured. Set EXECUTE=1 to send the transfers.`
				: `NOTE: no configured signer matches owner ${ownerOfPositions}. Add its key to ` +
						`DEPLOYER_PK or OPERATOR_PK in .env before running with EXECUTE=1.`,
		)
		return
	}

	if (!signer) {
		throw new Error(
			`\nThe positions to migrate are owned by ${ownerOfPositions}, but none of the configured ` +
				`signers match that address.\nAdd the private key for ${ownerOfPositions} to DEPLOYER_PK ` +
				`or OPERATOR_PK in .env, then re-run.`,
		)
	}
	console.log(`\nSigner (old treasury)   : ${signer.address}`)

	const npmWithSigner = npm.connect(signer) as any
	for (const id of toMove) {
		console.log(`\nTransferring position ${id} -> ${treasury} ...`)
		const tx = await npmWithSigner['safeTransferFrom(address,address,uint256)'](signer.address, treasury, id)
		console.log('  tx:', tx.hash)
		await tx.wait()
		console.log('  confirmed.')
	}
	console.log('\nMigration complete. The dApp will now value these positions as DAO-owned POL.')
}

main().catch((e) => {
	console.error(e)
	process.exitCode = 1
})
