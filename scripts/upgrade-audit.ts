import { ethers, upgrades, network } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

/**
 * KalyVault audit-fix upgrade driver (governance-gated).
 *
 * The testnet/mainnet proxies are governed by the DAO Timelock (sole DEFAULT_ADMIN), and
 * UUPS `_authorizeUpgrade` is admin-gated — so the deployer CANNOT call upgradeProxy directly.
 * The upgrade therefore runs through the Governor exactly like the Phase-2 handoff.
 *
 * The H-1 fix makes `referencePrice` decimals-INDEPENDENT, which breaks the live 6-decimal
 * refs (USDT/USDC were stored 1e12x larger). Rescaling them is blocked by the on-chain
 * deviation band, so this script folds EVERYTHING into ONE atomic proposal batch executed
 * by the Timelock in a single tx:
 *
 *   1. RewardsPool.upgradeTo(newImplRP)
 *   2. VaultManager.upgradeTo(newImplVM)
 *   3. VaultManager.grantRole(OPERATOR_ROLE, Timelock)         // so the Timelock may re-price
 *   4. VaultManager.setOperatorBounds(ceiling, 0, maxSlip)     // disable deviation band
 *   5. VaultManager.setReferencePrice(USDT, NEW_REF)           // rescale 6-dec stable
 *   6. VaultManager.setReferencePrice(USDC, NEW_REF)
 *   7. VaultManager.setOperatorBounds(ceiling, devBps, maxSlip)// restore band
 *   8. VaultManager.revokeRole(OPERATOR_ROLE, Timelock)        // clean up the temp role
 *
 * Because the batch is one transaction, the band is opened and closed atomically — no external
 * tx can interleave, and no separate operator key is needed.
 *
 * Usage (testnet defaults baked in; set DEPLOYER_PK in .env — it must hold the gKLC votes):
 *   STAGE=validate npx hardhat run scripts/upgrade-audit.ts --network testnet   # read-only layout check
 *   STAGE=prepare  npx hardhat run scripts/upgrade-audit.ts --network testnet   # deploy impls + build proposal
 *   STAGE=propose  npx hardhat run scripts/upgrade-audit.ts --network testnet   # submit to Governor
 *   STAGE=vote     npx hardhat run scripts/upgrade-audit.ts --network testnet   # castVote For (once Active)
 *   STAGE=queue    npx hardhat run scripts/upgrade-audit.ts --network testnet   # queue (once Succeeded)
 *   STAGE=execute  npx hardhat run scripts/upgrade-audit.ts --network testnet   # execute (after timelock delay)
 *   STAGE=status   npx hardhat run scripts/upgrade-audit.ts --network testnet   # proposal state + on-chain check
 *   STAGE=verify   npx hardhat run scripts/upgrade-audit.ts --network testnet   # post-execute assertions
 *
 * State (impl addresses, calldata, proposalId) persists to scripts/upgrade-audit.out.json so
 * each stage is a fresh process. The description string is fixed so the proposalId is stable.
 */

// --- addresses (testnet defaults; override via env for mainnet) ---
const VM = process.env.VAULT_MANAGER ?? '0xd97A80404990f6a734901e691D13385728A55A1D'
const RP = process.env.REWARDS_POOL ?? '0x36c908DA0DDEE1620F4fD2b97c9259F863ae41F8'
const GOVERNOR = process.env.GOVERNOR ?? '0x92177A348367D0122e043448e7f308ba989CFb3F'
const TIMELOCK = process.env.TIMELOCK ?? '0xAd338da8A2dDE5B5Fe08362c379c66D18Bb24151'
const USDT = process.env.USDT ?? '0x6Fdb0fEd277b878a0d80494b06EA054C99d2fdD2'
const USDC = process.env.USDC ?? '0x148d19609F3Ad595F8455225510f89cF0F121013'
// Decimals-independent reference price (WKLC 1e18 per 1.0 stable). Same as the live KUSD/DAI value.
const NEW_REF = BigInt(process.env.NEW_REF_PRICE ?? '416666666666666666666')

const DESC =
	'KalyVault audit-fix upgrade: upgrade VaultManager + RewardsPool implementations ' +
	'(H-1 swap-floor decimals, H-2 leftover sweep, F-7 weight snapshot, M-1 CEI, L hardening); ' +
	'rescale USDT + USDC referencePrice to the decimals-independent basis.'

const OPERATOR_ROLE = ethers.id('OPERATOR_ROLE')
const OUT = path.join(__dirname, 'upgrade-audit.out.json')

// Governor.state enum
const STATES = ['Pending', 'Active', 'Canceled', 'Defeated', 'Succeeded', 'Queued', 'Expired', 'Executed']

function patchGas() {
	// KalyChain (Besu) errors on eth_estimateGas; pin gas + legacy fee data.
	;(ethers.provider as any).estimateGas = async () => 10_000_000n
	;(ethers.provider as any).getFeeData = async () => new ethers.FeeData(21_000_000_000n, null, null)
}

function loadOut(): any {
	if (!fs.existsSync(OUT)) throw new Error(`missing ${OUT} — run STAGE=prepare first`)
	return JSON.parse(fs.readFileSync(OUT, 'utf8'))
}

async function signer0() {
	const s = (await ethers.getSigners())[0]
	if (!s) throw new Error('no signer — set DEPLOYER_PK in .env')
	return s
}

async function main() {
	const stage = process.env.STAGE ?? 'status'
	patchGas()
	console.log(`network: ${network.name}   stage: ${stage}`)
	console.log(`VaultManager: ${VM}\nRewardsPool : ${RP}\nGovernor    : ${GOVERNOR}\nTimelock    : ${TIMELOCK}\n`)

	const vm = await ethers.getContractAt('VaultManager', VM)
	const rp = await ethers.getContractAt('RewardsPool', RP)
	const gov = await ethers.getContractAt(
		[
			'function propose(address[],uint256[],bytes[],string) returns (uint256)',
			'function queue(address[],uint256[],bytes[],bytes32) returns (uint256)',
			'function execute(address[],uint256[],bytes[],bytes32) payable returns (uint256)',
			'function castVote(uint256,uint8) returns (uint256)',
			'function state(uint256) view returns (uint8)',
			'function hashProposal(address[],uint256[],bytes[],bytes32) view returns (uint256)',
			'function proposalDeadline(uint256) view returns (uint256)',
			'function proposalSnapshot(uint256) view returns (uint256)',
		],
		GOVERNOR,
	)

	if (stage === 'validate') {
		const VMF = await ethers.getContractFactory('VaultManager')
		const RPF = await ethers.getContractFactory('RewardsPool')
		console.log('Validating storage layout vs. the deployed manifest...')
		await upgrades.validateUpgrade(VM, VMF, { kind: 'uups' })
		console.log('  VaultManager: OK')
		await upgrades.validateUpgrade(RP, RPF, { kind: 'uups' })
		console.log('  RewardsPool : OK')
		console.log('\nLayout compatible — safe to STAGE=prepare.')
		return
	}

	if (stage === 'prepare') {
		const me = await signer0()
		console.log('deployer:', me.address)
		const VMF = await ethers.getContractFactory('VaultManager', me)
		const RPF = await ethers.getContractFactory('RewardsPool', me)

		console.log('Validating + deploying new implementations (proxies untouched)...')
		const implVM = (await upgrades.prepareUpgrade(VM, VMF, { kind: 'uups' })) as string
		const implRP = (await upgrades.prepareUpgrade(RP, RPF, { kind: 'uups' })) as string
		console.log('  new VaultManager impl:', implVM)
		console.log('  new RewardsPool  impl:', implRP)

		// Read current bounds so we restore them exactly (only the deviation band toggles).
		const ceiling = await vm.maxWeightCeiling()
		const devBps = await vm.maxRefPriceDeviationBps()
		const maxSlip = await vm.maxSlippageBps()
		console.log(`  current bounds: ceiling=${ceiling} devBps=${devBps} maxSlip=${maxSlip}`)

		const targets = [RP, VM, VM, VM, VM, VM, VM, VM]
		const values = targets.map(() => 0)
		const calldatas = [
			rp.interface.encodeFunctionData('upgradeTo', [implRP]),
			vm.interface.encodeFunctionData('upgradeTo', [implVM]),
			vm.interface.encodeFunctionData('grantRole', [OPERATOR_ROLE, TIMELOCK]),
			vm.interface.encodeFunctionData('setOperatorBounds', [ceiling, 0, maxSlip]),
			vm.interface.encodeFunctionData('setReferencePrice', [USDT, NEW_REF]),
			vm.interface.encodeFunctionData('setReferencePrice', [USDC, NEW_REF]),
			vm.interface.encodeFunctionData('setOperatorBounds', [ceiling, devBps, maxSlip]),
			vm.interface.encodeFunctionData('revokeRole', [OPERATOR_ROLE, TIMELOCK]),
		]
		const descHash = ethers.keccak256(ethers.toUtf8Bytes(DESC))
		const pid = (await gov.hashProposal(targets, values, calldatas, descHash)).toString()

		const out = { implVM, implRP, ceiling: ceiling.toString(), devBps: Number(devBps), maxSlip: Number(maxSlip), targets, values, calldatas, descHash, desc: DESC, pid, newRef: NEW_REF.toString() }
		fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
		console.log(`\nProposal built (8 actions). proposalId: ${pid}`)
		console.log(`Saved to ${OUT}. Next: STAGE=propose`)
		return
	}

	const o = loadOut()

	if (stage === 'propose') {
		const me = await signer0()
		console.log('proposing as', me.address, '...')
		const tx = await gov.connect(me).propose(o.targets, o.values, o.calldatas, o.desc, { gasLimit: 1_500_000 })
		const rc = await tx.wait()
		console.log('proposed. tx:', rc?.hash, '\nproposalId:', o.pid)
		console.log('Wait for the voting delay, then STAGE=vote (use STAGE=status to watch).')
		return
	}

	if (stage === 'vote') {
		const me = await signer0()
		const st = Number(await gov.state(o.pid))
		console.log('state:', STATES[st])
		if (st !== 1) throw new Error(`proposal not Active (is ${STATES[st]}) — wait for the voting delay`)
		const tx = await gov.connect(me).castVote(o.pid, 1, { gasLimit: 250_000 }) // 1 = For
		console.log('voted For. tx:', (await tx.wait())?.hash)
		return
	}

	if (stage === 'queue') {
		const me = await signer0()
		const st = Number(await gov.state(o.pid))
		console.log('state:', STATES[st])
		if (st !== 4) throw new Error(`proposal not Succeeded (is ${STATES[st]})`)
		const tx = await gov.connect(me).queue(o.targets, o.values, o.calldatas, o.descHash, { gasLimit: 800_000 })
		console.log('queued. tx:', (await tx.wait())?.hash, '\nWait for the Timelock delay, then STAGE=execute.')
		return
	}

	if (stage === 'execute') {
		const me = await signer0()
		const st = Number(await gov.state(o.pid))
		console.log('state:', STATES[st])
		if (st !== 5) throw new Error(`proposal not Queued (is ${STATES[st]}) — wait for the timelock delay`)
		const tx = await gov.connect(me).execute(o.targets, o.values, o.calldatas, o.descHash, { gasLimit: 2_000_000 })
		console.log('executed. tx:', (await tx.wait())?.hash)
		console.log('Run STAGE=verify to confirm impls + reference prices.')
		return
	}

	if (stage === 'status') {
		const st = Number(await gov.state(o.pid))
		console.log('proposalId:', o.pid)
		console.log('state     :', STATES[st], `(${st})`)
		try { console.log('snapshot  :', (await gov.proposalSnapshot(o.pid)).toString(), '(voting opens at block)') } catch {}
		try { console.log('deadline  :', (await gov.proposalDeadline(o.pid)).toString(), '(voting closes at block)') } catch {}
		console.log('block now :', await ethers.provider.getBlockNumber())
		return
	}

	if (stage === 'verify') {
		const implVM = await upgrades.erc1967.getImplementationAddress(VM)
		const implRP = await upgrades.erc1967.getImplementationAddress(RP)
		const usdtRef = await vm.referencePrice(USDT)
		const usdcRef = await vm.referencePrice(USDC)
		const devBps = await vm.maxRefPriceDeviationBps()
		const tlIsOperator = await vm.hasRole(OPERATOR_ROLE, TIMELOCK)
		console.log('VaultManager impl:', implVM, implVM.toLowerCase() === o.implVM.toLowerCase() ? '✓' : '✗ MISMATCH')
		console.log('RewardsPool  impl:', implRP, implRP.toLowerCase() === o.implRP.toLowerCase() ? '✓' : '✗ MISMATCH')
		console.log('USDT ref         :', usdtRef.toString(), usdtRef === NEW_REF ? '✓' : '✗')
		console.log('USDC ref         :', usdcRef.toString(), usdcRef === NEW_REF ? '✓' : '✗')
		console.log('deviation band   :', devBps.toString(), Number(devBps) === o.devBps ? '✓ restored' : '✗')
		console.log('Timelock operator:', tlIsOperator, tlIsOperator ? '✗ temp role NOT revoked' : '✓ revoked')
		return
	}

	throw new Error(`unknown STAGE "${stage}" — one of validate|prepare|propose|vote|queue|execute|status|verify`)
}

main().catch((e) => {
	console.error(e)
	process.exitCode = 1
})
