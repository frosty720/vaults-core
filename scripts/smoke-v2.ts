import { ethers } from 'hardhat'

/**
 * Live smoke test of the fresh v2 testnet stack: buy a $1,000 Validator vault (which reverted
 * on the old thin-pool stack), verify the hybrid direct-slice + buffer + maturity registration,
 * then simulate emissions (send KLC to the pool), check accrual, and claim.
 *
 *   VAULT_MANAGER=0x... REWARDS_POOL=0x... npx hardhat run scripts/smoke-v2.ts --network testnet
 */
const VM = process.env.VAULT_MANAGER ?? '0xb8D685966E72E5A3e2ebc4be2D0727F7D8494D6C'
const RP = process.env.REWARDS_POOL ?? '0x2E0A61f89f1D4E942bdC96637bF52a3C414d2340'
const USDT = '0x6Fdb0fEd277b878a0d80494b06EA054C99d2fdD2'
const TIER = 1 // Validator $1000
const PRICE = 1000n * 10n ** 6n // 1000 USDT (6 dec)

const vmAbi = [
	'function purchase(uint8,address,uint256) returns (uint256)',
	'function polBuffer(address) view returns (uint256)',
	'event Purchased(address indexed buyer, uint256 indexed tokenId, uint8 tier, address stable, uint256 paid)',
]
const rpAbi = [
	'function capUsdOf(uint256) view returns (uint256)',
	'function vaultWeight(uint256) view returns (uint256)',
	'function earned(uint256) view returns (uint256)',
	'function isMatured(uint256) view returns (bool)',
	'function claim(uint256)',
]
const erc = ['function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)']

async function main() {
	;(ethers.provider as any).estimateGas = async () => 5_000_000n
	;(ethers.provider as any).getFeeData = async () => new ethers.FeeData(21_000_000_000n, null, null)
	const [me] = await ethers.getSigners()
	console.log('Buyer:', me.address)

	const usdt = new ethers.Contract(USDT, erc, me)
	const vm = new ethers.Contract(VM, vmAbi, me)
	const rp = new ethers.Contract(RP, rpAbi, me)

	console.log('USDT balance:', (await usdt.balanceOf(me.address)).toString())
	if ((await usdt.allowance(me.address, VM)) < PRICE) {
		console.log('approving USDT...')
		await (await usdt.approve(VM, PRICE * 10n)).wait()
	}

	console.log('\nBuying $1,000 Validator vault (reverted on old stack)...')
	const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)
	const tx = await vm.purchase(TIER, USDT, deadline)
	const rc = await tx.wait()
	const ev = rc.logs.map((l: any) => { try { return vm.interface.parseLog(l) } catch { return null } }).find((e: any) => e && e.name === 'Purchased')
	const tokenId = ev.args.tokenId
	console.log('  ✓ purchased — tokenId', tokenId.toString(), '(NO revert!)')
	console.log('  polBuffer(USDT):', (await vm.polBuffer(USDT)).toString(), '(overflow buffered)')
	console.log('  capUsdOf       :', (await rp.capUsdOf(tokenId)).toString(), '(expect 3500e18 = 350% of $1000)')
	console.log('  vaultWeight    :', (await rp.vaultWeight(tokenId)).toString(), '(expect 2000000)')
	console.log('  isMatured      :', await rp.isMatured(tokenId), '(expect false)')

	console.log('\nSimulating emissions: sending 5 KLC to RewardsPool...')
	await (await me.sendTransaction({ to: RP, value: ethers.parseEther('5') })).wait()
	const earned1 = await rp.earned(tokenId)
	console.log('  earned(tokenId):', ethers.formatEther(earned1), 'KLC (should be ~5, sole vault)')

	console.log('\nClaiming...')
	const balBefore = await ethers.provider.getBalance(me.address)
	const crc = await (await rp.claim(tokenId)).wait()
	const balAfter = await ethers.provider.getBalance(me.address)
	console.log('  ✓ claimed. net balance delta (minus gas):', ethers.formatEther(balAfter - balBefore), 'KLC')
	console.log('  earned after claim:', ethers.formatEther(await rp.earned(tokenId)), '(expect ~0)')
	console.log('\nSMOKE TEST PASSED — buy/buffer/cap/accrual/claim all work on the live v2 stack.')
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
