/**
 * fund-reserve.ts — fund the VaultManager's WKLC POL-seed reserve.
 *
 * Run by the BOSS (or any funder) — fundReserve() is permissionless payable; it wraps the
 * native KLC you send into WKLC and holds it in the VaultManager. See runbook §2.1 / Phase D.
 *
 * Usage:
 *   VAULT_MANAGER=0x... RESERVE_KLC=16000000 npx hardhat run scripts/fund-reserve.ts --network mainnet
 *
 * RESERVE_KLC sizing: reserve = 0.8 * expectedSales$ / klcPrice  (runbook §3B table).
 * The funder's wallet must hold RESERVE_KLC + gas. Sent in <1M-KLC chunks (signer value cap).
 */
import { ethers } from 'hardhat'

const VAULT_MANAGER = process.env.VAULT_MANAGER ?? ''
const RESERVE_KLC = process.env.RESERVE_KLC ?? ''

async function main() {
	if (!VAULT_MANAGER) throw new Error('set VAULT_MANAGER (the deployed mainnet VaultManager)')
	if (!RESERVE_KLC) throw new Error('set RESERVE_KLC (whole KLC, e.g. 16000000 — see runbook §3B)')

	;(ethers.provider as any).estimateGas = async () => 200_000n
	;(ethers.provider as any).getFeeData = async () => new ethers.FeeData(21_000_000_000n, null, null)

	const [funder] = await ethers.getSigners()
	if (!funder) throw new Error('no signer — set DEPLOYER_PK (or the funder key) in .env')

	const abi = ['function fundReserve() payable', 'function reserveWklc() view returns (uint256)']
	const vm = new ethers.Contract(VAULT_MANAGER, abi, funder)

	const before: bigint = await vm.reserveWklc()
	console.log('Funder      :', funder.address)
	console.log('VaultManager:', VAULT_MANAGER)
	console.log('reserve before:', ethers.formatEther(before), 'WKLC')

	const total = ethers.parseEther(RESERVE_KLC)
	const CHUNK = ethers.parseEther('900000') // < 1M KLC per tx (signer value cap)
	let funded = 0n, ci = 0
	while (funded < total) {
		const amt = total - funded > CHUNK ? CHUNK : total - funded
		const t = await vm.fundReserve({ value: amt })
		await t.wait()
		funded += amt
		console.log(`  ✓ chunk ${++ci}: +${ethers.formatEther(amt)} KLC  (cumulative ${ethers.formatEther(funded)})`)
	}

	const after: bigint = await vm.reserveWklc()
	console.log('reserve after :', ethers.formatEther(after), 'WKLC')
	console.log('added         :', ethers.formatEther(after - before), 'WKLC')
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
