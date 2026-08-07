// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

// v2: THIS FILE IS QUARANTINED.
// The Echidna/Medusa harness used the per-address API (onWeightChange, weightOf, earned(address),
// claim()). All those methods are removed in RewardsPool v2.
// New fuzz harnesses for per-vault accrual/maturity will be added in a later task.
