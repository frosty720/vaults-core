import { ethers, network } from 'hardhat'
import { deployStack } from './lib/deploy-stack'
import { TIERS } from './deploy.config'
/**
 * Buy-path simulation on a MAINNET FORK. Proves the full purchase path works with the mainnet
 * config (minBuyUsd=1) on the real, thin mainnet pools: market-buy slice + seed-leg LP mint +
 * fee routing, across small/large tiers and both stables. NO real funds — fork only.
 *
 *   FORK=1 npx hardhat run scripts/sim-buypath.ts --network hardhat
 */

// Set an ERC20 balance on a fork by finding the balanceOf storage slot. Tries both Solidity
// (keccak(holder,slot)) and Vyper (keccak(slot,holder)) mapping layouts, over a wide slot range.
async function setTokenBalance(token: string, holder: string, amount: bigint): Promise<string> {
	const erc = new ethers.Contract(token, ['function balanceOf(address) view returns (uint256)'], ethers.provider)
	const coder = ethers.AbiCoder.defaultAbiCoder()
	for (let slot = 0; slot < 80; slot++) {
		for (const key of [
			ethers.keccak256(coder.encode(['address', 'uint256'], [holder, slot])), // Solidity
			ethers.keccak256(coder.encode(['uint256', 'address'], [slot, holder])), // Vyper
		]) {
			const prev = await ethers.provider.getStorage(token, key)
			await network.provider.send('hardhat_setStorageAt', [token, key, ethers.toBeHex(amount, 32)])
			if ((await erc.balanceOf(holder)) === amount) return `slot ${slot}`
			await network.provider.send('hardhat_setStorageAt', [token, key, prev]) // restore wrong guesses
		}
	}
	throw new Error('balanceOf slot not found for ' + token)
}

async function main() {
	const chainId = Number((await ethers.provider.getNetwork()).chainId)
	if (chainId !== 3888) throw new Error('run with: FORK=1 npx hardhat run scripts/sim-buypath.ts --network hardhat (needs chainId 3888)')

	const [deployer, buyer] = await ethers.getSigners()
	// Fund deployer (to seed a big reserve) and buyer (gas) with native KLC on the fork.
	await network.provider.send('hardhat_setBalance', [deployer.address, ethers.toBeHex(ethers.parseEther('200000000'))])
	await network.provider.send('hardhat_setBalance', [buyer.address, ethers.toBeHex(ethers.parseEther('1000'))])

	const { vm, vmAddr, C } = await deployStack()

	// Fund the WKLC reserve generously (one tx on the fork; the 900k chunking is a real-network signer cap).
	console.log('\nFunding reserve 50,000,000 KLC (sim)...')
	await (await (vm as any).fundReserve({ value: ethers.parseEther('50000000') })).wait()
	console.log('  reserveWklc:', ethers.formatEther(await (vm as any).reserveWklc()), 'WKLC')

	const npm = new ethers.Contract(C.npm, ['function balanceOf(address) view returns (uint256)'], ethers.provider)

	const tests = [
		{ sym: 'USDT', tier: 0 }, // $50 Starter
		{ sym: 'USDT', tier: 2 }, // $1,000 Pro1K
		{ sym: 'USDT', tier: 7 }, // $100,000 Whale
		{ sym: 'KUSD', tier: 1 }, // $100 Basic (other stable)
	]

	console.log('\n=== BUY-PATH SIMULATION (mainnet fork, minBuyUsd=' + C.minBuyUsd + ') ===')
	let pass = 0
	for (const t of tests) {
		const s = C.stables.find((x) => x.sym === t.sym)!
		const tier = TIERS[t.tier]
		const amount = BigInt(tier.priceUSD) * 10n ** BigInt(s.decimals)
		await setTokenBalance(s.addr, buyer.address, amount * 2n)
		const stable = new ethers.Contract(s.addr, ['function approve(address,uint256) returns (bool)'], buyer)
		await (await stable.approve(vmAddr, ethers.MaxUint256)).wait()

		const treBefore: bigint = await npm.balanceOf(C.treasury)
		const vaultsBefore: bigint = await (vm as any).balanceOf(buyer.address)
		const resBefore: bigint = await (vm as any).reserveWklc()
		const deadline = BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 3600)

		try {
			const rc = await (await (vm.connect(buyer) as any).purchase(t.tier, s.addr, deadline)).wait()
			const treAfter: bigint = await npm.balanceOf(C.treasury)
			const vaultsAfter: bigint = await (vm as any).balanceOf(buyer.address)
			const resAfter: bigint = await (vm as any).reserveWklc()
			const lpAdded = treAfter - treBefore
			const reserveUsed = resBefore - resAfter
			const ok = lpAdded > 0n && vaultsAfter > vaultsBefore
			console.log(`${ok ? '✓' : '✗'} $${tier.priceUSD.toLocaleString()} ${tier.name} via ${t.sym}: gas ${rc!.gasUsed}, treasury LP +${lpAdded}, buyer vaults ${vaultsBefore}->${vaultsAfter}, reserve used ${ethers.formatEther(reserveUsed)} WKLC`)
			if (ok) pass++
		} catch (e: any) {
			console.log(`✗ $${tier.priceUSD.toLocaleString()} ${tier.name} via ${t.sym}: REVERTED — ${e.shortMessage || e.message}`)
		}
	}
	console.log(`\nRESULT: ${pass}/${tests.length} buys succeeded (LP minted to treasury + vault NFT to buyer).`)
	if (pass !== tests.length) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
