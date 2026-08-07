import { ethers, upgrades } from 'hardhat'
import { getNetCfg, TIERS, NetCfg } from '../deploy.config'
/**
 * deployStack() — the v4 deploy logic, importable so both the runner (deploy-v2-stack.ts) and the
 * buy-path simulation (sim-buypath.ts) exercise the IDENTICAL code path. No top-level side effects.
 * Picks the settings block by connected chainId. Admin = operator = deployer during deploy.
 */
export async function deployStack(): Promise<{ vm: any; rp: any; vmAddr: string; rpAddr: string; C: NetCfg }> {
	// KalyChain (Besu): pin gas + legacy fee so every tx carries an explicit gasLimit.
	;(ethers.provider as any).estimateGas = async () => 10_000_000n
	;(ethers.provider as any).getFeeData = async () => new ethers.FeeData(21_000_000_000n, null, null)

	const chainId = Number((await ethers.provider.getNetwork()).chainId)
	const C = getNetCfg(chainId)

	const [deployer] = await ethers.getSigners()
	if (!deployer) throw new Error('no signer — set DEPLOYER_PK in .env')
	const me = deployer.address
	console.log(`Deploying v4 stack to ${C.label} (chainId ${chainId})`)
	console.log('Deployer (temp admin+operator):', me)
	console.log('treasury:', C.treasury, '| dev:', C.dev, '| stables:', C.stables.map((s) => s.sym).join('+'))
	console.log('minBuyUsd:', C.minBuyUsd, '| maxTotalWeight:', C.maxTotalWeight.toString())

	console.log('\nDeploying PolLib...')
	const polLib = await (await ethers.getContractFactory('PolLib')).deploy()
	await polLib.waitForDeployment()
	console.log('  PolLib:', await polLib.getAddress())

	console.log('Deploying VaultManager...')
	const VM = await ethers.getContractFactory('VaultManager', { libraries: { PolLib: await polLib.getAddress() } })
	const vm = await upgrades.deployProxy(VM, [me, me, me, C.treasury, C.wklc, C.router, C.npm], { kind: 'uups', unsafeAllow: ['external-library-linking'] })
	await vm.waitForDeployment()
	const vmAddr = await vm.getAddress()
	console.log('  VaultManager:', vmAddr)

	console.log('Deploying RewardsPool...')
	const RP = await ethers.getContractFactory('RewardsPool')
	const rp = await upgrades.deployProxy(RP, [me, vmAddr, vmAddr], { kind: 'uups' })
	await rp.waitForDeployment()
	const rpAddr = await rp.getAddress()
	console.log('  RewardsPool:', rpAddr)

	const tx = async (label: string, p: Promise<any>) => { const t = await p; await t.wait(); console.log('  ✓', label) }

	console.log('\nWiring...')
	await tx('setRewardsPool', (vm as any).setRewardsPool(rpAddr))
	await tx('setOperatorBounds', (vm as any).setOperatorBounds(C.maxWeightCeiling, C.maxRefDevBps, C.maxSlippageBps))
	await tx('initializeV2', (vm as any).initializeV2())
	await tx(`setBuyParams (buyImpactBps=${C.buyImpactBps}, minBuyUsd=${C.minBuyUsd})`, (vm as any).setBuyParams(C.buyImpactBps, C.minBuyUsd))
	await tx('initializeV3 (80/20 + 3-level MLM)', (vm as any).initializeV3(C.treasury))
	await tx('setMaxTotalWeight (sales OPEN)', (vm as any).setMaxTotalWeight(C.maxTotalWeight))
	await tx('setFeeRecipients', (vm as any).setFeeRecipients(C.dev, C.amb, C.builders))

	const ercBal = ['function balanceOf(address) view returns (uint256)']
	const wklcC = new ethers.Contract(C.wklc, ercBal, ethers.provider)
	for (const s of C.stables) {
		await tx(`setStable ${s.sym}`, (vm as any).setStable(s.addr, true, s.decimals, s.pool, s.fee))
		const stableC = new ethers.Contract(s.addr, ercBal, ethers.provider)
		const sRes: bigint = await stableC.balanceOf(s.pool)
		const wRes: bigint = await wklcC.balanceOf(s.pool)
		const ref = sRes > 0n ? ((wRes * 10n ** BigInt(s.decimals)) / sRes) * 98n / 100n : C.refFallback
		await tx(`setReferencePrice ${s.sym} (${(Number(ref) / 1e18).toFixed(2)} WKLC/$, live spot)`, (vm as any).setReferencePrice(s.addr, ref))
	}
	await tx('setPriceAnchor', (vm as any).setPriceAnchor(C.priceAnchor))

	if (!C.metadataCid) console.warn('  ⚠ metadataCid empty — tiers get placeholder URIs; set METADATA_CID and re-run setTier before public launch')
	for (let i = 0; i < TIERS.length; i++) {
		const t = TIERS[i]
		const uri = C.metadataCid ? `ipfs://${C.metadataCid}/${i}.json` : `ipfs://TODO-METADATA_CID/${i}.json`
		await tx(`setTier ${i} ${t.name} (${uri})`, (vm as any).setTier(i, t.priceUSD, t.aprBps, uri, true))
		await tx(`setTierCap ${i} (${t.capBps} bps)`, (vm as any).setTierCap(i, t.capBps))
	}

	// Reserve funded separately (scripts/fund-reserve.ts). Grant OPERATOR_ROLE to keeper if provided.
	const KEEPER = process.env.KEEPER_ADDRESS ?? ''
	if (KEEPER && KEEPER.toLowerCase() !== me.toLowerCase()) {
		await tx(`grant OPERATOR_ROLE -> keeper ${KEEPER}`, (vm as any).grantRole(ethers.id('OPERATOR_ROLE'), KEEPER))
	}

	const reserve = await (vm as any).reserveWklc()
	console.log(`\n=== ${C.label} v4 stack deployed ===`)
	console.log('VaultManager :', vmAddr)
	console.log('RewardsPool  :', rpAddr)
	console.log('reserveWklc  :', ethers.formatEther(reserve), 'WKLC  (fund via scripts/fund-reserve.ts)')
	console.log('Save: VAULT_MANAGER=' + vmAddr + '  REWARDS_POOL=' + rpAddr)
	return { vm, rp, vmAddr, rpAddr, C }
}
