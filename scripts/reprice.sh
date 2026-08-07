#!/usr/bin/env bash
# reprice.sh — set VaultManager referencePrice to current pool spot for USDT + KUSD.
# Usage: ./scripts/reprice.sh   (DEPLOYER_PK read from env or .env)
# Interim tool until the reprice keeper exists (2026-07-06 slippage incident).
set -euo pipefail

RPC=https://rpc.kalychain.io/rpc
VM=0x8ad3ad4a3f20672d39f6f87d6bdf1df5386ac6a5

if [ -z "${DEPLOYER_PK:-}" ] && [ -f "$(dirname "$0")/../.env" ]; then
	DEPLOYER_PK=$(grep -E '^DEPLOYER_PK=' "$(dirname "$0")/../.env" | cut -d= -f2- | tr -d '"' | tr -d "'")
fi
: "${DEPLOYER_PK:?DEPLOYER_PK not set and not found in .env}"

reprice() {
	local sym=$1 stable=$2 pool=$3 dec=$4
	local sp ref cur
	sp=$(cast call "$pool" "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" --rpc-url "$RPC" | head -1 | cut -d' ' -f1)
	ref=$(python3 -c "print(2**192 * 10**$dec // $sp**2)")
	cur=$(cast call "$VM" "referencePrice(address)(uint256)" "$stable" --rpc-url "$RPC" | cut -d' ' -f1)
	echo "$sym: ref $cur -> $ref ($(python3 -c "print(f'{($ref/$cur-1)*100:+.1f}%')"))"
	cast send "$VM" "setReferencePrice(address,uint256)" "$stable" "$ref" --rpc-url "$RPC" --private-key "$DEPLOYER_PK" --gas-limit 200000
}

reprice USDT 0x2CA775C77B922A51FcF3097F52bFFdbc0250D99A 0x3848C7C8D088549194A264Cb1d639258AbE406a9 6
reprice KUSD 0xCd02480926317748e95c5bBBbb7D1070b2327f1A 0xf8c867c0f07eba68b2acf07b9ffd45b1aa1ddcfe 18
