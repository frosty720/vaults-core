import { ethers } from 'hardhat'
import { TIERS } from './deploy.config'
/**
 * Re-set the 8 tier metadata URIs to the uploaded ipfs folder (use when the stack was deployed
 * before METADATA_CID was available). setTier overwrites in place and leaves tierCapBps untouched.
 * Run by the admin (deployer, before DAO handoff).
 *
 *   VAULT_MANAGER=0x... METADATA_CID=Qm... npx hardhat run scripts/set-metadata.ts --network mainnet
 */
async function main() {
	;(ethers.provider as any).estimateGas = async () => 10_000_000n
	;(ethers.provider as any).getFeeData = async () => new ethers.FeeData(21_000_000_000n, null, null)

	const VM = process.env.VAULT_MANAGER
	const CID = process.env.METADATA_CID
	if (!VM) throw new Error('set VAULT_MANAGER (deployed VaultManager proxy)')
	if (!CID || CID.includes('TODO')) throw new Error('set METADATA_CID (ipfs folder CID from upload-nft-metadata.sh)')

	const [signer] = await ethers.getSigners()
	const vm = new ethers.Contract(VM, [
		'function setTier(uint8,uint256,uint16,string,bool)',
		'function tiers(uint256) view returns (uint256 priceUSD, uint16 aprBps, uint256 weight, string metadataURI, bool active)',
	], signer)

	console.log('Setting tier metadata on', VM, 'as', signer.address)
	for (let i = 0; i < TIERS.length; i++) {
		const t = TIERS[i]
		const uri = `ipfs://${CID}/${i}.json`
		await (await vm.setTier(i, t.priceUSD, t.aprBps, uri, true)).wait()
		console.log(`  ✓ tier ${i} ${t.name} -> ${uri}`)
	}
	console.log('\nVerify:', `https://dweb.link/ipfs/${CID}/0.json`)
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
