/**
 * deploy.config.ts — THE single source of deploy settings for every network.
 *
 * One place to change anything. scripts/deploy-v2-stack.ts picks the block by the
 * connected chainId (3889 testnet / 3888 mainnet) and runs the IDENTICAL code path
 * for both — the only difference between networks is the data here.
 *
 * Tier economics (price/APR/cap) are shared (same 8 packs on both); only addresses,
 * the stable set, price anchor, NFT metadata CID, and a few tuning scalars differ.
 */

export interface StableCfg { sym: string; addr: string; decimals: number; pool: string; fee: number }
export interface TierCfg { name: string; priceUSD: number; aprBps: number; capBps: number }
export interface NetCfg {
	label: string
	wklc: string; router: string; npm: string; treasury: string
	dev: string; amb: string; builders: string
	stables: StableCfg[]
	priceAnchor: string
	/** ipfs folder CID holding 0.json..7.json; tier i -> ipfs://<cid>/<i>.json. '' => placeholder URI. */
	metadataCid: string
	maxRefDevBps: number
	maxSlippageBps: number
	buyImpactBps: number
	/** per-buy market-buy floor (whole USD). 1 on mainnet so the slice auto-scales to 3% of pool depth. */
	minBuyUsd: number
	maxTotalWeight: bigint
	maxWeightCeiling: bigint
	/** referencePrice fallback (KLC per $1, 1e18) used only if a pool's live spot can't be read. */
	refFallback: bigint
}

// 8 packs — identical economics on both networks.
export const TIERS: TierCfg[] = [
	{ name: 'Starter', priceUSD: 50, aprBps: 3000, capBps: 15000 },
	{ name: 'Basic', priceUSD: 100, aprBps: 4000, capBps: 20000 },
	{ name: 'Pro1K', priceUSD: 1000, aprBps: 5000, capBps: 25000 },
	{ name: 'Pro5K', priceUSD: 5000, aprBps: 6000, capBps: 30000 },
	{ name: 'Premium10K', priceUSD: 10000, aprBps: 7000, capBps: 35000 },
	{ name: 'Premium25K', priceUSD: 25000, aprBps: 8000, capBps: 40000 },
	{ name: 'Elite50K', priceUSD: 50000, aprBps: 10000, capBps: 50000 },
	{ name: 'Whale100K', priceUSD: 100000, aprBps: 14000, capBps: 70000 },
]

const REF_FALLBACK = 416666666666666666666n // ~$0.0024/KLC; live pool spot overrides per stable

export const NETWORKS: Record<number, NetCfg> = {
	// ── KMT relaunch chain (3890) — addresses from kalychain-ops/files/kmt-3890/addresses.json (2026-08-21) ──
	3890: {
		label: 'kmt-3890',
		wklc: '0xf90F0Bd56558Ac12F7FC285571D38181d2feD69b', // WKMT (WETH9)
		router: '0x290F0B0cce8b9AA8F21C57BC7dDc3768D05F3f5b', // SwapRouter02
		npm: '0xCa4a8fC696ADAE8edC042cB9E32Cd7F0A28EBdf0',
		treasury: '0xDF8CFefEa7DaA5E5B23c262A461aCcA6356BCA90', // new Treasury (ERC721-capable, execute)
		dev: '0x12BA3F424d630A583BdBCa56b0c1A0a7C1d7D66e', // core dev wallet (unchanged)
		amb: '0xDF8CFefEa7DaA5E5B23c262A461aCcA6356BCA90',
		builders: '0xDF8CFefEa7DaA5E5B23c262A461aCcA6356BCA90',
		stables: [
			// USDT only at launch (KUSD re-enabled once KUSD is live on 3890; USDC once backed)
			{ sym: 'USDT', addr: '0x6318EcDbae6B469D39C38949eDC671f4bA8A6172', decimals: 6, pool: '0xa9Ac6D3c75A883Cc5D6EfE7EbB973c68174bA61F', fee: 3000 },
		],
		priceAnchor: '0x6318EcDbae6B469D39C38949eDC671f4bA8A6172', // USDT
		metadataCid: process.env.METADATA_CID ?? 'QmcQnJQgQpAqz1piZsqAubV1NjteTmxk6S3GvssqNcs8Be', // same 8 tier JSONs as 3888
		maxRefDevBps: 4000,
		maxSlippageBps: 2000,
		buyImpactBps: 300,
		minBuyUsd: 1,
		maxTotalWeight: BigInt(process.env.MAX_TOTAL_WEIGHT ?? '1000000000000'),
		maxWeightCeiling: BigInt(process.env.MAX_WEIGHT_CEILING ?? '10000000000000'),
		refFallback: 5_000_000_000_000_000_000n, // 5 KMT per $1 (= $0.20/KMT); live pool spot overrides
	},
	// ── KalyChain TESTNET (3889) — values that produced the live testnet stack ──
	3889: {
		label: 'testnet',
		wklc: '0x069255299Bb729399f3CECaBdc73d15d3D10a2A3',
		router: '0x3246523054b0Bb123372ecf204740Cb04f6E713e',
		npm: '0x8064558662896B2941B2BF88eb51182b4152d61B',
		treasury: '0x5aE2cf3fC0B99003C64bBDC7836D08064ED43Aab',
		dev: '0x5f255373428C995cE62205C87f605aBD4362BFc4',
		amb: '0xC3878e88AFc26b7e223a8acEb78ecf8ba8900b9E',
		builders: '0x5aE2cf3fC0B99003C64bBDC7836D08064ED43Aab',
		stables: [
			{ sym: 'KUSD', addr: '0xd15F19c457AaaCB7A389B305Dac8611Cd2294c36', decimals: 18, pool: '0x090077817153dF024D115942E656c965674E190c', fee: 3000 },
			{ sym: 'USDT', addr: '0x6Fdb0fEd277b878a0d80494b06EA054C99d2fdD2', decimals: 6, pool: '0x4594540BD03928683042E479D4DDF8Ad8705Be5C', fee: 3000 },
			{ sym: 'DAI', addr: '0x1e7B8b36b703dDdAAe1bCfedF7BB3876D87b35F3', decimals: 18, pool: '0xFA235E914C79EC20CAB660dED9ab23EaA46fe583', fee: 3000 },
			{ sym: 'USDC', addr: '0x148d19609F3Ad595F8455225510f89cF0F121013', decimals: 6, pool: '0x86Cc2Bf4A68dfA9A7725170808205ae26c586142', fee: 3000 },
		],
		priceAnchor: '0x6Fdb0fEd277b878a0d80494b06EA054C99d2fdD2', // USDT
		metadataCid: '',
		maxRefDevBps: 4000,
		maxSlippageBps: 2000,
		buyImpactBps: 300,
		minBuyUsd: 100, // historical testnet value (preserves original behavior on a re-deploy)
		maxTotalWeight: 1_000_000_000_000n, // uncapped for testing
		maxWeightCeiling: 1_000_000_000_000n,
		refFallback: REF_FALLBACK,
	},

	// ── KalyChain MAINNET (3888) — verified on-chain 2026-06-29 ──
	3888: {
		label: 'mainnet',
		wklc: '0x069255299Bb729399f3CECaBdc73d15d3D10a2A3',
		router: '0xEAd6d6ea2aBbe807AC728Eb92c77865b62C41893',
		npm: '0xfa25364Ec856E1C0dd6D14568456C842b288E519',
		treasury: '0x92564ec0d22BBd5e3FF978B977CA968e6c7d1c44', // DAO Treasury
		dev: '0x12BA3F424d630A583BdBCa56b0c1A0a7C1d7D66e', // core dev wallet
		amb: '0x92564ec0d22BBd5e3FF978B977CA968e6c7d1c44', // legacy/unused in v4 routing -> treasury
		builders: '0x92564ec0d22BBd5e3FF978B977CA968e6c7d1c44',
		stables: [
			{ sym: 'KUSD', addr: '0xCd02480926317748e95c5bBBbb7D1070b2327f1A', decimals: 18, pool: '0xf8c867c0f07eba68b2acf07b9ffd45b1aa1ddcfe', fee: 3000 },
			{ sym: 'USDT', addr: '0x2CA775C77B922A51FcF3097F52bFFdbc0250D99A', decimals: 6, pool: '0x3848c7c8d088549194a264cb1d639258abe406a9', fee: 3000 },
			// Enabled 2026-08-17 via scripts/mainnet-usdc-bootstrap.ts (band bootstrap after the
			// inverted-price fix; bridged Hyperlane synthetic USDC).
			{ sym: 'USDC', addr: '0x9cAb0c396cF0F4325913f2269a0b72BD4d46E3A9', decimals: 6, pool: '0x65dd443dfc57f9731ae0fd157b8999976f5fe8ae', fee: 3000 },
		],
		priceAnchor: '0x2CA775C77B922A51FcF3097F52bFFdbc0250D99A', // USDT
		metadataCid: process.env.METADATA_CID ?? '', // from upload-nft-metadata.sh
		maxRefDevBps: 4000,
		maxSlippageBps: 2000,
		buyImpactBps: 300,
		minBuyUsd: 1, // thin-pool bootstrap: market-buy auto-scales to 3% of depth; $1 avoids the zero-swap edge
		// maxTotalWeight caps total reward WEIGHT (= Σ priceUSD*aprBps), NOT reserve $. A single Whale =
		// 100000*14000 = 1.4B weight, so the cap must be generous or large tiers revert 'VM: cap exceeded'.
		// Reserve $ is bounded separately by funding (degraded mode is the graceful overflow). 1e12 (proven
		// on testnet) is effectively uncapped for launch; lower it only to bound reward exposure (keep >= 1.4B).
		maxTotalWeight: BigInt(process.env.MAX_TOTAL_WEIGHT ?? '1000000000000'),
		maxWeightCeiling: BigInt(process.env.MAX_WEIGHT_CEILING ?? '10000000000000'), // 10x headroom
		refFallback: REF_FALLBACK,
	},
}

export function getNetCfg(chainId: number): NetCfg {
	const cfg = NETWORKS[chainId]
	if (!cfg) throw new Error(`no deploy config for chainId ${chainId} (supported: ${Object.keys(NETWORKS).join(', ')})`)
	return cfg
}
