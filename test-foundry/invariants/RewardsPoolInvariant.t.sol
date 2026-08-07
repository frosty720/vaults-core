// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

// v2: THIS FILE IS QUARANTINED.
// The per-address RewardsPool invariants (solvent, weightConservation) were invalidated by the
// RewardsPool v2 rewrite (per-vault tokenId storage, no onWeightChange/weightOf/claim(address)).
// New per-vault maturity invariants will be added in a later task (Vault Maturity v2 — invariants).
// DO NOT restore this file without updating it to the v2 API.
