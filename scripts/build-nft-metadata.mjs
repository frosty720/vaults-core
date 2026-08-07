// Generates the 8 ERC-721 metadata JSONs (one per pack) into ./metadata/.
// All packs share the one certificate image; the pack is conveyed via attributes.
// After uploading the image to IPFS, pass its URI so it's baked into each JSON:
//   IMAGE_URI="ipfs://<cid>/vaults-nft.png" node scripts/build-nft-metadata.mjs
// (defaults to a placeholder you can find/replace if you upload separately.)
import { mkdirSync, writeFileSync } from 'fs'

const IMAGE_URI = process.env.IMAGE_URI ?? 'ipfs://__IMAGE_CID__/vaults-nft.png'

const TIERS = [
	{ i: 0, name: 'Starter',     price: 50,     apr: 30,  cap: 150 },
	{ i: 1, name: 'Basic',       price: 100,    apr: 40,  cap: 200 },
	{ i: 2, name: 'Pro 1K',      price: 1000,   apr: 50,  cap: 250 },
	{ i: 3, name: 'Pro 5K',      price: 5000,   apr: 60,  cap: 300 },
	{ i: 4, name: 'Premium 10K', price: 10000,  apr: 70,  cap: 350 },
	{ i: 5, name: 'Premium 25K', price: 25000,  apr: 80,  cap: 400 },
	{ i: 6, name: 'Elite 50K',   price: 50000,  apr: 100, cap: 500 },
	{ i: 7, name: 'Whale 100K',  price: 100000, apr: 140, cap: 700 },
]

mkdirSync('metadata', { recursive: true })
for (const t of TIERS) {
	const meta = {
		name: `KalyChain Vault — ${t.name}`,
		description:
			'KalyChain Vault Partnership NFT. Buy once, earn KLC every block — every purchase is backed by ' +
			'protocol-owned liquidity locked in the DAO treasury. Rewards stream in native KLC by weight ' +
			'until the vault reaches its lifetime ROI cap. Verified on-chain. Liquidity locked forever.',
		image: IMAGE_URI,
		external_url: 'https://vaults.kalychain.io',
		attributes: [
			{ trait_type: 'Pack', value: t.name },
			{ trait_type: 'Activation', value: `$${t.price.toLocaleString()}` },
			{ trait_type: 'APR', value: `${t.apr}%` },
			{ trait_type: 'ROI Cap', value: `${t.cap}%` },
			{ trait_type: 'Standard', value: 'ERC-721' },
		],
	}
	writeFileSync(`metadata/${t.i}.json`, JSON.stringify(meta, null, 2) + '\n')
	console.log(`wrote metadata/${t.i}.json  (${meta.name})`)
}
console.log(`\nimage = ${IMAGE_URI}`)
