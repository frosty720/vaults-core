# vault-reprice-keeper

Keeps `VaultManager.referencePrice[stable]` aligned with each stable's Uniswap V3 pool spot
price, so vault purchases never revert with `Price slippage check` again.

## Why this exists

See `../docs/REPRICE_KEEPER_HANDOFF.md` for the full incident writeup. Short version:
`referencePrice` is a static, operator-set value used to size the LP legs of every purchase's
POL deployment, but the mint itself is checked against the pool's live spot price. Left alone,
organic trading drifts the two apart until purchases start reverting. This keeper watches the
drift and calls the existing `setReferencePrice` operator function before that happens.

## How it decides (see `src/services/decision.ts`)

Every tick, per stable:

1. **Purchases already blocked?** (instant drift ≥ the contract's own `slippageBps`) — reprice
   immediately to spot, bypassing the smoothing window and the rate limit.
2. **Smoothed drift over threshold?** (median of the last `SAMPLE_WINDOW` samples ≥
   `REPRICE_THRESHOLD_BPS`, and not rate-limited) — reprice to the median.
3. **Drift elevated but not actionable?** (≥ `ALERT_THRESHOLD_BPS`) — alert only.
4. Otherwise — do nothing.

Reprice targets are always clamped to the contract's own `±maxRefPriceDeviationBps` band, so a
computed target can never produce a transaction that reverts on-chain.

The median-of-samples smoothing exists so a single-block price wick (e.g. a manipulation
attempt) can't drag the reference price with it — see the "Manipulation guard" section of the
handoff doc for the reasoning and the current limitation (both pools have observation
cardinality 1, so on-chain TWAP isn't available yet; this is the interim mitigation).

## Setup

```bash
cp .env.example .env
# fill in KEEPER_PK and VAULT_MANAGER
npm install
npm test              # unit tests, 90%+ coverage required on all pure logic
npm run build
npm start              # or: pm2 start ecosystem.config.js
```

Run `npm run dev` (ts-node, no build step) while iterating locally.

### Dry run

Set `DRY_RUN=true` (and `KEEPER_PK` can then be left blank) to log every decision the keeper
would make against live chain state without ever sending a transaction. Useful for validating
thresholds against real drift before turning it loose with a funded key.

## Key handling

The keeper wallet must hold `OPERATOR_ROLE` on the `VaultManager`. On startup the keeper calls
`assertOperatorRole()` and fails fast with a clear error if it doesn't.

**Prefer a dedicated keeper wallet over the admin/deployer key.** Grant it the role from the
admin wallet:

```bash
cast send $VAULT_MANAGER "grantRole(bytes32,address)" $(cast keccak "OPERATOR_ROLE") $KEEPER_ADDRESS \
  --rpc-url https://rpc.kalychain.io/rpc --private-key $ADMIN_PK
```

That way the admin key never needs to live on the server running this keeper. The existing
operator-only mainnet wallet (`0x3765db2f21382240a8ef5f5e5690a6958f473d27`) is also an option if
its key is available.

## Alerts

`ALERT_WEBHOOK_URL`, if set, receives a generic JSON POST (`{"text": "...", ...meta}` — directly
compatible with Slack/Discord incoming webhooks, or point it at your own endpoint). Console +
`logs/` output is always active regardless, so nothing is silently lost even with no webhook
configured.

## Deploying with pm2

```bash
npm run build
pm2 start ecosystem.config.js
pm2 logs vault-reprice-keeper
```

Mirrors the pm2 fork-mode setup already used by `KUSD/kusd-keeper` and `KUSD/psm-keeper` — see
memory `kaly-vault-deploy` for the node20/nvm/pm2 gotchas on the vault server.

## Testing notes

- `src/utils/math.ts` and `src/services/decision.ts` are pure and carry fixture tests built from
  the real on-chain values captured during the 2026-07-06 incident (see the test files) —
  changing the reprice formula or thresholds should break these first if it breaks the contract.
- `src/services/RepriceService.ts` is tested against a fake `IContractService`/`Alerter`, not
  real ethers — it verifies orchestration policy (rate limiting, paused/dry-run guards, alerting
  rules, per-stable error isolation), not RPC behavior.
- `src/services/ContractService.ts` and `src/index.ts` are intentionally excluded from the
  coverage threshold (`jest.config.js`) — they're thin ethers/process wiring with no branching
  logic of their own. Verify them by running against a mainnet fork (anvil) per the handoff
  doc's "Definition of done" before deploying against real funds.
