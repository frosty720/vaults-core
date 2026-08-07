#!/usr/bin/env bash
# KalyVault DAO Phase-2 handoff driver.
#
# Read-only stages (status) need no key. Sending stages require your signing key:
#   export PK=0xYOUR_KEY
#   bash scripts/phase2.sh grants     # Stage 1: grant DEFAULT_ADMIN to the Timelock
#   bash scripts/phase2.sh propose    # Stage 2a: submit the test proposal
#   bash scripts/phase2.sh vote       # Stage 2b: cast For vote (once Active)
#   bash scripts/phase2.sh queue      # Stage 2c: queue on Timelock (once Succeeded)
#   bash scripts/phase2.sh execute    # Stage 2d: execute (after the 1h timelock)
#   bash scripts/phase2.sh renounce   # Stage 3: renounce deployer admin (LAST)
#   bash scripts/phase2.sh status     # read-only: block + proposal state
#
# The proposal action is setOperatorBounds(1e10, 4000, 1000) on VaultManager
# (tighten maxRefPriceDeviationBps 5000 -> 4000). CALLDATA/DESCHASH/PID below are
# precomputed and MUST stay in sync with that exact action + description string.
set -uo pipefail

RPC=https://testnetrpc.kalychain.io/rpc
GOV=0x92177A348367D0122e043448e7f308ba989CFb3F
TL=0xAd338da8A2dDE5B5Fe08362c379c66D18Bb24151
VM=0xd97A80404990f6a734901e691D13385728A55A1D
RP=0x36c908DA0DDEE1620F4fD2b97c9259F863ae41F8
ME=0xaE51f2EfE70e57b994BE8F7f97C4dC824c51802a
ADMIN_ROLE=0x0000000000000000000000000000000000000000000000000000000000000000

# precomputed for action: setOperatorBounds(10000000000, 4000, 1000)
CALLDATA=0xd68ba6f400000000000000000000000000000000000000000000000000000002540be4000000000000000000000000000000000000000000000000000000000000000fa000000000000000000000000000000000000000000000000000000000000003e8
DESC="KalyVault Phase-2 e2e: tighten maxRefPriceDeviationBps 5000->4000"
DESCHASH=0xc2c31e4f47ccee6d466b6291c12bbc490b621ddb32b100e4bd3e49d5a9df0912
PID=58223903603631270164078770829574578715012200740362483042671651482951945945910

need_pk() {
	if [ -z "${PK:-}" ]; then
		echo "ERROR: no signing key. Run:  export PK=0xYOUR_KEY" >&2
		exit 1
	fi
	GAS="--legacy --gas-price 21000000000 --rpc-url $RPC --private-key $PK"
}

stage="${1:-status}"
case "$stage" in
	grants)
		need_pk
		echo ">> grant DEFAULT_ADMIN to Timelock on VaultManager"
		cast send $VM "grantRole(bytes32,address)" $ADMIN_ROLE $TL --gas-limit 120000 $GAS
		echo ">> grant DEFAULT_ADMIN to Timelock on RewardsPool"
		cast send $RP "grantRole(bytes32,address)" $ADMIN_ROLE $TL --gas-limit 120000 $GAS
		;;
	propose)
		need_pk
		echo ">> submit proposal (setOperatorBounds 1e10/4000/1000)"
		cast send $GOV "propose(address[],uint256[],bytes[],string)" "[$VM]" "[0]" "[$CALLDATA]" "$DESC" --gas-limit 600000 $GAS
		;;
	vote)
		need_pk
		echo ">> castVote For (support=1)"
		cast send $GOV "castVote(uint256,uint8)" $PID 1 --gas-limit 200000 $GAS
		;;
	queue)
		need_pk
		echo ">> queue on Timelock"
		cast send $GOV "queue(address[],uint256[],bytes[],bytes32)" "[$VM]" "[0]" "[$CALLDATA]" $DESCHASH --gas-limit 400000 $GAS
		;;
	execute)
		need_pk
		echo ">> execute"
		cast send $GOV "execute(address[],uint256[],bytes[],bytes32)" "[$VM]" "[0]" "[$CALLDATA]" $DESCHASH --gas-limit 400000 $GAS
		;;
	renounce)
		need_pk
		echo ">> renounce deployer DEFAULT_ADMIN on VaultManager"
		cast send $VM "renounceRole(bytes32,address)" $ADMIN_ROLE $ME --gas-limit 120000 $GAS
		echo ">> renounce deployer DEFAULT_ADMIN on RewardsPool"
		cast send $RP "renounceRole(bytes32,address)" $ADMIN_ROLE $ME --gas-limit 120000 $GAS
		;;
	status)
		echo "block: $(cast block-number --rpc-url $RPC)"
		echo "PID  : $PID"
		echo -n "state (0=Pend 1=Active 3=Defeated 4=Succeeded 5=Queued 7=Executed): "
		cast call $GOV "state(uint256)(uint8)" $PID --rpc-url $RPC 2>&1 | head -1
		;;
	*)
		echo "usage: bash scripts/phase2.sh {grants|propose|vote|queue|execute|renounce|status}" >&2
		exit 1
		;;
esac
