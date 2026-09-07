import { HardhatUserConfig } from 'hardhat/config'
import '@nomicfoundation/hardhat-toolbox'
import '@openzeppelin/hardhat-upgrades'
import 'solidity-coverage'
import * as dotenv from 'dotenv'
dotenv.config()

const MAINNET_RPC = process.env.KALY_MAINNET_RPC ?? 'https://rpc.kalychain.io/rpc'

const config: HardhatUserConfig = {
	solidity: {
		version: '0.8.19',
		settings: {
			optimizer: { enabled: true, runs: 1 }, // size-mode: VaultManager is near the 24KB limit (POL+maturity+MLM)
			viaIR: true,
			metadata: { bytecodeHash: 'none' }, // drop the trailing CBOR/IPFS hash (~50 bytes) to fit under 24KB
		},
	},
	networks: {
		hardhat: process.env.FORK
			? { forking: { url: MAINNET_RPC }, chainId: 3888 }
			: { accounts: { count: 20, accountsBalance: '1000000000000000000000000' } },
		// local `anvil --fork-url <mainnet rpc> --auto-impersonate` — used by scripts/revoke-incident.ts dry-runs
		anvil: { url: 'http://127.0.0.1:8545', chainId: 3888 },
		// anvil --fork-url https://mainrpc.kalychain.io/rpc --port 8545 (chain 3890 fork) — signs with DEPLOYER_PK locally, nothing leaves the box
		anvil3890: { url: 'http://127.0.0.1:8545', chainId: 3890, accounts: process.env.DEPLOYER_PK ? [process.env.DEPLOYER_PK] : [], gas: 10_000_000, gasPrice: 21_000_000_000 },
		// KMT relaunch chain (chainId 3890) — public RPC mainrpc.kalychain.io (testnetrpc retired 2026-09-07)
		kmt: {
			url: process.env.KMT_RPC ?? 'https://mainrpc.kalychain.io/rpc',
			chainId: 3890,
			accounts: process.env.DEPLOYER_PK ? [process.env.DEPLOYER_PK] : [],
			gas: 10_000_000,
			gasPrice: 21_000_000_000,
		},
		testnet: {
			url: process.env.KALY_TESTNET_RPC ?? 'https://testnetrpc.kalychain.io/rpc',
			chainId: 3889,
			// account[0] = admin/deployer, account[1] = operator (optional, for operator-gated config)
			accounts: [process.env.DEPLOYER_PK, process.env.OPERATOR_PK].filter(Boolean) as string[],
			// KalyChain (Besu) errors on eth_estimateGas; pin explicit legacy gas so
			// hardhat-ethers / OZ upgrades skip estimation. Block gas limit is ~2^53.
			gas: 10_000_000,
			gasPrice: 21_000_000_000, // 21 gwei
		},
		mainnet: {
			url: MAINNET_RPC,
			chainId: 3888,
			accounts: process.env.DEPLOYER_PK ? [process.env.DEPLOYER_PK] : [],
			gas: 10_000_000,
			gasPrice: 21_000_000_000, // 21 gwei
		},
	},
	// KalyScan is Blockscout — verify via its Etherscan-compatible API. apiKey can be any non-empty string.
	etherscan: {
		apiKey: { kalychain: process.env.KALYSCAN_API_KEY ?? 'blockscout', kmt: 'blockscout' },
		customChains: [
			{
				network: 'kalychain',
				chainId: 3888,
				urls: { apiURL: 'https://kalyscan.io/api', browserURL: 'https://kalyscan.io' },
			},
			{
				network: 'kmt',
				chainId: 3890,
				urls: { apiURL: 'https://testnet.kalyscan.io/api', browserURL: 'https://testnet.kalyscan.io' },
			},
		],
	},
}
export default config
