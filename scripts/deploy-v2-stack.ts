/**
 * Deploy the v4 vault stack (PolLib + VaultManager + RewardsPool) — ONE script for ALL networks.
 * Thin runner around deployStack() (scripts/lib/deploy-stack.ts); settings live in deploy.config.ts.
 *
 *   npx hardhat run scripts/deploy-v2-stack.ts --network testnet
 *   MAX_TOTAL_WEIGHT=110000000 METADATA_CID=<cid> npx hardhat run scripts/deploy-v2-stack.ts --network mainnet
 *
 * After deploy: fund the reserve separately (scripts/fund-reserve.ts), and hand off admin to the
 * DAO Timelock (scripts/phase2.sh). Reserve funding is NOT done here.
 */
import { deployStack } from './lib/deploy-stack'

deployStack().catch((e) => { console.error(e); process.exitCode = 1 })
