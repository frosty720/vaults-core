import { ethers } from 'hardhat'
import * as fs from 'fs'
import { deployStack } from './lib/deploy-stack'
import { TIERS } from './deploy.config'

/**
 * Chain 3890 vault relaunch: deploy the v5 stack (deployStack, config 3890), then re-create every live
 * snapshot vault under its original id/owner, restore sponsors, carry unclaimed rewards (KLC/RATIO -> KMT, default 110:1),
 * close the migration (one-way), fund the WKMT reserve, reopen sales.
 *
 *   STAGE=deploy  npx hardhat run scripts/relaunch-3890.ts --network kmt   # deploy + pause + PAUSER + reserve; migration stays OPEN, sales PAUSED
 *   STAGE=migrate VAULT_MANAGER=0x.. REWARDS_POOL=0x.. SNAPSHOT_DIR=<final snapshot> npx hardhat run scripts/relaunch-3890.ts --network kmt
 *                 # at the FINAL CUT (3888 sales paused, fresh snapshot): fund carry, migrate all, assert, close, unpause
 *   (--network anvil3890 for fork dry-runs of either stage)
 *
 * Why two stages: vaults keep selling/transferring/claiming on 3888 until the cut, and a migrated vault cannot be
 * re-migrated — so the migration runs exactly once, from the snapshot taken when 3888 vault activity stops.
 */
const SNAP = process.env.SNAPSHOT_DIR ?? '/home/dude/KalyChain/relaunch-planning/snapshot/53459482'
const RESERVE_KMT = process.env.RESERVE_KMT ?? '131370' // old 13,137,024 WKLC reserve /100 (funded live 2026-08-21, before the 110:1 ruling — over-provisioned vs /110=119,427; harmless, boss can trim)
const RATIO = BigInt(process.env.RATIO ?? '110') // 110:1 KLC->KMT (boss-confirmed 2026-08-24; was 100 pre-ruling)
const BATCH = Number(process.env.BATCH ?? 25)
const OUT = process.env.OUT ?? '/tmp/vaults-3890-dryrun.json'
const E = ethers.parseEther
const STAGE = process.env.STAGE ?? 'deploy'

type Row = { tokenId: string; owner: string; tier: string; weight: string; sponsor: string; earnedKlc: string; earnedUsd: string; capUsd: string; matured: string; burned: string }
function readCsv(p: string): Row[] {
	const [h, ...lines] = fs.readFileSync(p, 'utf8').trim().split('\n'); const keys = h.split(',')
	return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [keys[i], v])) as unknown as Row)
}
const must = (c: boolean, m: string) => { if (!c) throw new Error('ASSERT: ' + m) }

async function main() {
	const net = await ethers.provider.getNetwork()
	must(Number(net.chainId) === 3890, `wrong chain ${net.chainId}`)
	const [dep] = await ethers.getSigners()
	const tx = async (label: string, p: Promise<any>) => { const t = await p; const r = await t.wait(); must(r.status === 1, label + ' failed'); console.log('  ✓', label); return r }
	const b0 = await ethers.provider.getBlockNumber()
	let vm: any, rp: any, vmAddr: string, rpAddr: string

	if (STAGE === 'deploy') {
		;({ vm, rp, vmAddr, rpAddr } = await deployStack())
		console.log('\n=== deploy stage: pause sales (until the final-cut migration), PAUSER, reserve ===')
		await tx('pause sales (3890 sells nothing until the migration is closed)', vm.pause())
		await tx('grant PAUSER_ROLE (emergency tier) -> deployer', rp.grantRole(await rp.PAUSER_ROLE(), dep.address))
		const chunk = E('900000'); let left = E(RESERVE_KMT)
		while (left > 0n) { const v = left > chunk ? chunk : left; await tx(`fundReserve ${ethers.formatEther(v)} KMT`, vm.fundReserve({ value: v })); left -= v }
		console.log('  reserveWklc:', ethers.formatEther(await vm.reserveWklc()), 'WKMT')
		must(await vm.paused(), 'must stay paused'); must(!(await vm.migrationClosed()), 'migration must stay open')
		const out = { chainId: 3890, stage: 'deploy', vaultManager: vmAddr, rewardsPool: rpAddr, deployBlocks: { from: b0, to: await ethers.provider.getBlockNumber() }, reserveKmt: RESERVE_KMT, admin: dep.address, salesPaused: true, migrationClosed: false, next: 'STAGE=migrate at the final cut (fresh snapshot)' }
		fs.writeFileSync(OUT, JSON.stringify(out, null, 2)); console.log('\nwritten', OUT, JSON.stringify(out, null, 2)); return
	}

	must(STAGE === 'migrate', 'STAGE must be deploy|migrate')
	vmAddr = process.env.VAULT_MANAGER ?? ''; rpAddr = process.env.REWARDS_POOL ?? ''
	must(!!vmAddr && !!rpAddr, 'set VAULT_MANAGER + REWARDS_POOL for STAGE=migrate')
	;(ethers.provider as any).estimateGas = async () => 10_000_000n
	;(ethers.provider as any).getFeeData = async () => new ethers.FeeData(21_000_000_000n, null, null)
	vm = await ethers.getContractAt('VaultManager', vmAddr, dep); rp = await ethers.getContractAt('RewardsPool', rpAddr, dep)
	must(!(await vm.migrationClosed()), 'migration already closed'); must(await vm.paused(), 'pause 3890 sales first')
	console.log(`\n=== migrate stage from ${SNAP} ===`)

	// SINGLE SOURCE OF TRUTH: exclude bad-actor owners + their vault ids (relaunch-planning/bad-actor-addresses.txt)
	const BAD_FILE = process.env.BAD_ACTOR_FILE ?? '/home/dude/KalyChain/relaunch-planning/bad-actor-addresses.txt'
	const badTxt = fs.readFileSync(BAD_FILE, 'utf8')
	const BADADDR = new Set([...badTxt.matchAll(/^0x[0-9a-fA-F]{40}/gm)].map((m) => m[0].toLowerCase()))
	const BADVAULTS = new Set((badTxt.match(/^BAD-ACTOR VAULTS:\s*(.+)$/m)?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean))
	console.log(`bad-actor list: ${BADADDR.size} addresses, ${BADVAULTS.size} vault ids [${[...BADVAULTS].join(',')}]`)
	const allLive = readCsv(`${SNAP}/vaults.csv`).filter((r) => r.owner && r.burned !== 'BURNED')
	const rows = allLive.filter((r) => !BADADDR.has(r.owner.toLowerCase()) && !BADVAULTS.has(r.tokenId))
	const dropped = allLive.filter((r) => BADADDR.has(r.owner.toLowerCase()) || BADVAULTS.has(r.tokenId))
	console.log(`DROPPED ${dropped.length} bad-actor vaults (NOT migrated, NOT rewarded): ${dropped.map((r) => r.tokenId).join(',')}`)
	must(dropped.length > 0, 'expected to drop bad-actor vaults — bad-actor file may not have loaded')
	const entries = rows.map((r) => ({
		id: BigInt(r.tokenId), owner: r.owner, tier: Number(r.tier), sponsor: r.sponsor || ethers.ZeroAddress,
		accruedKlc: E(r.earnedKlc) / RATIO, earnedUsd: E(r.earnedUsd), capUsd: E(r.capUsd), matured: r.matured === 'true',
	}))
	const carry = entries.reduce((s, e) => s + e.accruedKlc, 0n)
	const ldb0 = await rp.lastDistributedBalance()
	const pot0 = (await ethers.provider.getBalance(rpAddr)) - ldb0 // mining rewards accumulated since the beneficiary flip — distributed to migrated vaults by weight (by design)
	console.log(`vaults to migrate: ${entries.length}  carried rewards: ${ethers.formatEther(carry)} KMT  matured: ${entries.filter((e) => e.matured).length}  pre-existing mining pot: ${ethers.formatEther(pot0)} KMT`)
	await tx(`fund RewardsPool with carried rewards ${ethers.formatEther(carry)} KMT`, dep.sendTransaction({ to: rpAddr, value: carry }))

	console.log('\n=== migrating ===')
	for (let i = 0; i < entries.length; i += BATCH) {
		const batch = entries.slice(i, i + BATCH)
		await tx(`migrateVaults ids ${batch[0].id}..${batch[batch.length - 1].id} (${batch.length})`, vm.migrateVaults(batch))
	}

	console.log('\n=== asserting against the snapshot ===')
	let sumW = 0n, sumWActive = 0n; const seenOwner = new Set<string>()
	for (const r of rows) {
		const id = BigInt(r.tokenId); const t = TIERS[Number(r.tier)]; const w = BigInt(t.priceUSD) * BigInt(t.aprBps)
		must((await vm.ownerOf(id)).toLowerCase() === r.owner.toLowerCase(), `owner ${id}`)
		must(Number(await vm.tierOf(id)) === Number(r.tier), `tier ${id}`)
		must((await vm.vaultWeight(id)) === w && w === BigInt(r.weight), `weight ${id}`)
		const exp = E(r.earnedKlc) / RATIO; const got = await rp.earned(id)
		// active vaults also get a weight-share of the mining pot accrued since the beneficiary flip (intended), USD-cap-clamped — never below the carried amount
		must(r.matured === 'true' ? got === exp : got >= exp, `earned ${id} (carried ${exp}, got ${got})`)
		must((await rp.isMatured(id)) === (r.matured === 'true'), `matured ${id}`)
		must((await rp.capUsdOf(id)) === E(r.capUsd) && (await rp.earnedUsdOf(id)) === E(r.earnedUsd), `cap/earnedUsd ${id}`)
		const o = r.owner.toLowerCase()
		if (!seenOwner.has(o)) { seenOwner.add(o); must((await vm.sponsorOf(r.owner)).toLowerCase() === (r.sponsor || ethers.ZeroAddress).toLowerCase(), `sponsor ${o}`) }
		sumW += w; if (r.matured !== 'true') sumWActive += w
	}
	must((await vm.totalWeight()) === sumW, 'VM.totalWeight'); must((await rp.totalWeight()) === sumWActive, 'RP.totalWeight')
	must((await vm.nextTokenId()) === BigInt(Math.max(...rows.map((r) => Number(r.tokenId)))) + 1n, 'nextTokenId')
	must((await rp.lastDistributedBalance()) === ldb0 + carry, 'carry earmarked (ldb = pre + carry)')
	console.log(`  ok — ${rows.length} vaults, ${seenOwner.size} holders, VM.totalWeight ${sumW}, RP.totalWeight ${sumWActive}, nextTokenId ${await vm.nextTokenId()}`)

	console.log('\n=== close + reopen ===')
	await tx('closeMigration (one-way)', vm.closeMigration())
	must(await vm.migrationClosed(), 'closed')
	await tx('unpause sales', vm.unpause())
	const b1 = await ethers.provider.getBlockNumber()

	const out = { chainId: 3890, stage: 'migrate', vaultManager: vmAddr, rewardsPool: rpAddr, migrateBlocks: { from: b0, to: b1 }, snapshot: SNAP, ratio: String(RATIO), migrated: rows.length, carriedRewardsKmt: ethers.formatEther(carry), admin: dep.address, note: 'admin/operator/pauser = deployer until DAO Timelock; miningbeneficiary transition to rewardsPool still TODO' }
	fs.writeFileSync(OUT, JSON.stringify(out, null, 2)); console.log('\nwritten', OUT, JSON.stringify(out, null, 2))
}
main().catch((e) => { console.error(e); process.exit(1) })
