import { ethers, network, upgrades } from 'hardhat'

/**
 * 2026-08-21 KUSD incident — revoke vaults 173/174/175 (bought with KUSD minted via the
 * Clipper.redo() exploit). Upgrades VaultManager + RewardsPool (UUPS, deployer = DEFAULT_ADMIN
 * on mainnet) to add revokeVaults()/revokeVault(), then revokes the three ids.
 *
 *   anvil --fork-url https://rpc.kalychain.io/rpc --auto-impersonate     # terminal 1
 *   npx hardhat run scripts/revoke-incident.ts --network anvil            # dry-run on the mainnet fork
 *   npx hardhat run scripts/revoke-incident.ts --network mainnet          # live (DEPLOYER_PK in .env)
 *
 * Both paths run the SAME steps + assertions; the fork path impersonates the deployer.
 */

const VM_PROXY = '0x8ad3aD4a3F20672d39F6F87d6bdf1DF5386ac6A5'
const RP_PROXY = '0x8b80800Cf6dA88D59EB09CaE4Fd2196423c48b26'
const POL_LIB = '0x1877902204a29D5803162efD87a32704d5F4aA7e' // unchanged; link new VM impl to it
const DEPLOYER = '0xaE51f2EfE70e57b994BE8F7f97C4dC824c51802a'
const ATTACKER = '0x7deEF7a942858f34F2C9C50B175605884Ee8f2ee'
const REVOKE_IDS = [173n, 174n, 175n]
const CONTROL_IDS = [172n, 176n, 150n, 1n] // untouched neighbours / a real customer's vault
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

async function main() {
	const fork = !!process.env.FORK || network.name === 'anvil'
	const chainId = (await ethers.provider.getNetwork()).chainId
	console.log(`=== ${fork ? 'FORK DRY-RUN' : 'LIVE'}  network=${network.name} chainId=${chainId} block=${await ethers.provider.getBlockNumber()}`)
	if (chainId !== 3888n) throw new Error('not KalyChain mainnet (3888)')

	// KalyChain (Besu) errors on eth_estimateGas (gasPrice x 2^53 block gas limit balance check);
	// pin gas + legacy fee data like scripts/upgrade-audit.ts does. 10M covers the ~5M impl deploy.
	;(ethers.provider as any).estimateGas = async () => 10_000_000n
	;(ethers.provider as any).getFeeData = async () => new ethers.FeeData(21_000_000_000n, null, null)

	let signer
	if (fork) {
		await ethers.provider.send('hardhat_impersonateAccount', [DEPLOYER])
		await ethers.provider.send('hardhat_setBalance', [DEPLOYER, '0x3635C9ADC5DEA00000']) // 1000 KLC
		signer = await ethers.getSigner(DEPLOYER)
	} else {
		signer = (await ethers.getSigners())[0]
		if (!signer) throw new Error('no signer — set DEPLOYER_PK in .env')
		if (signer.address.toLowerCase() !== DEPLOYER.toLowerCase()) throw new Error(`signer ${signer.address} is not the deployer ${DEPLOYER}`)
	}
	console.log(`signer ${signer.address}  balance ${ethers.formatEther(await ethers.provider.getBalance(signer.address))} KLC`)

	const vm = await ethers.getContractAt('VaultManager', VM_PROXY, signer)
	const rp = await ethers.getContractAt('RewardsPool', RP_PROXY, signer)
	const ADMIN = ethers.ZeroHash
	if (!(await vm.hasRole(ADMIN, signer.address))) throw new Error('signer lacks DEFAULT_ADMIN_ROLE on VaultManager')
	if (!(await rp.hasRole(ADMIN, signer.address))) throw new Error('signer lacks DEFAULT_ADMIN_ROLE on RewardsPool')
	if (!(await rp.hasRole(await rp.WEIGHT_UPDATER_ROLE(), VM_PROXY))) throw new Error('VM lacks WEIGHT_UPDATER_ROLE on RP')

	// ---------- snapshot state that MUST survive the upgrade unchanged ----------
	const snap = async () => ({
		nextTokenId: await vm.nextTokenId(),
		totalWeight: await vm.totalWeight(),
		maxTotalWeight: await vm.maxTotalWeight(),
		tier4: await vm.tiers(4),
		usdtCfg: await vm.stables('0x2CA775C77B922A51FcF3097F52bFFdbc0250D99A'),
		refUsdt: await vm.referencePrice('0x2CA775C77B922A51FcF3097F52bFFdbc0250D99A'),
		anchor: await vm.priceAnchorStable(),
		daoTreasury: await vm.daoTreasury(),
		feeSplit: [await vm.n1Bps(), await vm.n2Bps(), await vm.n3Bps(), await vm.devBps(), await vm.daoBps()],
		rpTotalWeight: await rp.totalWeight(),
		rpVm: await rp.vaultManager(),
		rpRpw: await rp.rewardPerWeightStored(),
		controls: await Promise.all(CONTROL_IDS.map(async (id) => ({
			id, owner: await vm.ownerOf(id), w: await vm.vaultWeight(id), rpw: await rp.vaultWeight(id), cap: await rp.capUsd(id),
		}))),
	})
	const before = await snap()
	const revokeWeights = await Promise.all(REVOKE_IDS.map((id) => vm.vaultWeight(id)))
	const revokeEarned = await Promise.all(REVOKE_IDS.map((id) => rp.earned(id)))
	const controlEarnedBefore = await Promise.all(CONTROL_IDS.map((id) => rp.earned(id)))
	console.log('before: nextTokenId', before.nextTokenId, 'VM.totalWeight', before.totalWeight, 'RP.totalWeight', before.rpTotalWeight)
	for (let i = 0; i < REVOKE_IDS.length; i++) {
		console.log(`  vault ${REVOKE_IDS[i]} owner ${await vm.ownerOf(REVOKE_IDS[i])} weight ${revokeWeights[i]} earned ${ethers.formatEther(revokeEarned[i])} KLC`)
	}
	const implVmBefore = await ethers.provider.getStorage(VM_PROXY, IMPL_SLOT)
	const implRpBefore = await ethers.provider.getStorage(RP_PROXY, IMPL_SLOT)
	console.log('impl before: VM', '0x' + implVmBefore.slice(26), 'RP', '0x' + implRpBefore.slice(26))

	// ---------- deploy new implementations ----------
	const VMF = await ethers.getContractFactory('VaultManager', { libraries: { PolLib: POL_LIB }, signer })
	const RPF = await ethers.getContractFactory('RewardsPool', signer)
	await upgrades.validateImplementation(VMF, { kind: 'uups', unsafeAllow: ['external-library-linking'] })
	await upgrades.validateImplementation(RPF, { kind: 'uups' })
	const vmImpl = await VMF.deploy(); await vmImpl.waitForDeployment()
	const rpImpl = await RPF.deploy(); await rpImpl.waitForDeployment()
	console.log('new impl: VM', vmImpl.target, 'RP', rpImpl.target)

	// ---------- upgrade ----------
	await (await rp.upgradeTo(rpImpl.target)).wait()
	await (await vm.upgradeTo(vmImpl.target)).wait()
	const implVmAfter = await ethers.provider.getStorage(VM_PROXY, IMPL_SLOT)
	const implRpAfter = await ethers.provider.getStorage(RP_PROXY, IMPL_SLOT)
	if ('0x' + implVmAfter.slice(26) !== String(vmImpl.target).toLowerCase()) throw new Error('VM impl slot mismatch')
	if ('0x' + implRpAfter.slice(26) !== String(rpImpl.target).toLowerCase()) throw new Error('RP impl slot mismatch')
	console.log('upgraded; impl slots verified')

	// state must read identically through the new code
	const mid = await snap()
	if (JSON.stringify(mid, bn) !== JSON.stringify(before, bn)) {
		console.log('BEFORE', JSON.stringify(before, bn, 1)); console.log('AFTER', JSON.stringify(mid, bn, 1))
		throw new Error('state changed across upgrade — ABORT')
	}
	console.log('post-upgrade state identical to pre-upgrade')

	// ---------- revoke ----------
	const tx = await vm.revokeVaults(REVOKE_IDS)
	const rc = await tx.wait()
	console.log(`revokeVaults tx ${rc!.hash} status ${rc!.status}`)
	for (const log of rc!.logs) {
		try { const p = vm.interface.parseLog(log as any); if (p?.name === 'VaultRevoked') console.log(`  VaultRevoked id=${p.args[0]} owner=${p.args[1]} forfeited=${ethers.formatEther(p.args[2])} KLC`) } catch {}
	}

	// ---------- assertions ----------
	const sumW = revokeWeights.reduce((a, b) => a + b, 0n)
	const after = await snap()
	const must = (cond: boolean, msg: string) => { if (!cond) throw new Error('ASSERT FAILED: ' + msg); console.log('  ok -', msg) }
	must(after.totalWeight === before.totalWeight - sumW, `VM.totalWeight dropped by exactly ${sumW}`)
	must(after.rpTotalWeight === before.rpTotalWeight - sumW, `RP.totalWeight dropped by exactly ${sumW}`)
	must(after.nextTokenId === before.nextTokenId, 'nextTokenId unchanged')
	for (const id of REVOKE_IDS) {
		must(await vm.ownerOf(id).then(() => false, () => true), `ownerOf(${id}) reverts (burned)`)
		must((await vm.vaultWeight(id)) === 0n && (await rp.vaultWeight(id)) === 0n, `vault ${id} weight zero in both`)
		must((await rp.earned(id)) === 0n && (await rp.accrued(id)) === 0n, `vault ${id} earned/accrued zero`)
		must(await rp.isMatured(id), `vault ${id} marked matured (cannot re-register)`)
	}
	must((await vm.balanceOf(ATTACKER)) === 0n, 'attacker holds no vaults')
	for (let i = 0; i < CONTROL_IDS.length; i++) {
		const c = after.controls[i]
		must(c.owner === before.controls[i].owner && c.w === before.controls[i].w && c.rpw === before.controls[i].rpw, `control vault ${c.id} owner/weight untouched`)
		must((await rp.earned(c.id)) >= controlEarnedBefore[i], `control vault ${c.id} earned did not decrease`)
	}
	console.log('\nALL ASSERTIONS PASSED')
	console.log(JSON.stringify({ vmImpl: vmImpl.target, rpImpl: rpImpl.target, revokeTx: rc!.hash, revoked: REVOKE_IDS.map(String) }, null, 2))
}

function bn(_: string, v: any) { return typeof v === 'bigint' ? v.toString() : v }

main().catch((e) => { console.error(e); process.exit(1) })
